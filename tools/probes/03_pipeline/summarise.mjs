// Turns out/bench_all.json into the markdown tables used in FINDINGS.md.
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from './lib.mjs';

const b = JSON.parse(fs.readFileSync(path.join(OUT, 'bench_all.json'), 'utf8'));
const lines = [];
const p = (s) => lines.push(s);

p('ENV: ' + JSON.stringify(b.env));
p('node baseline RSS: ' + b.nodeBaselineMB + ' MB');
p('');
p('| run | wall (s) | ms/img | img/s | rAF p50 | rAF p95 | rAF p99 | rAF max | frames>50ms | page heap peak MB | proc RSS idle→peak MB | ΔRSS | thumb KB | preview KB | errors |');
p('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of b.runs) {
  const f = r.frames || {};
  const rss = r.processRss || {};
  p(
    `| ${r.label} | ${(r.wallMs / 1000).toFixed(1)} | ${r.perImageMs} | ${r.throughputPerSec} | ` +
      `${f.median != null ? f.median.toFixed(1) : '-'} | ${f.p95 != null ? f.p95.toFixed(1) : '-'} | ` +
      `${f.p99 != null ? f.p99.toFixed(1) : '-'} | ${f.max != null ? f.max.toFixed(0) : '-'} | ${f.over50ms ?? '-'} | ` +
      `${r.pageHeap ? r.pageHeap.peakMB : '-'} | ${rss.idleBeforeMB}→${rss.peakMB} | ${rss.peakMB - rss.idleBeforeMB} | ` +
      `${(r.bytes.thumbMean / 1024).toFixed(1)} | ${(r.bytes.previewMean / 1024).toFixed(1)} | ${r.errorCount} |`
  );
}
p('');
p('STAGE BREAKDOWN (mean ms inside the worker, per image)');
p('| run | decode | resizePreview | encodePreview | resizeThumb | encodeThumb | hash | total |');
p('|---|---|---|---|---|---|---|---|');
for (const r of b.runs) {
  const s = r.stageMs || {};
  const g = (k) => (s[k] ? s[k].mean : '-');
  p(`| ${r.label} | ${g('decode')} | ${g('resizePreview')} | ${g('encodePreview')} | ${g('resizeThumb')} | ${g('encodeThumb')} | ${g('hash')} | ${g('total')} |`);
}
p('');
p('MEMORY PLATEAU CHECK (process RSS, first half vs second half of each run)');
p('| run | RSS 1st-half mean | RSS 2nd-half mean | drift | RSS end | heap 1st-half | heap 2nd-half |');
p('|---|---|---|---|---|---|---|');
for (const r of b.runs) {
  const s = r.processRss || {};
  const h = r.pageHeap || {};
  p(
    `| ${r.label} | ${s.firstHalfMeanMB} | ${s.secondHalfMeanMB} | ${s.secondHalfMeanMB - s.firstHalfMeanMB} | ${s.endMB} | ${h.firstHalfMeanMB ?? '-'} | ${h.secondHalfMeanMB ?? '-'} |`
  );
}
p('');
p('IDB: ');
for (const r of b.runs) {
  p(
    `  ${r.label}: records=${r.idbRecords} thumbBytes=${r.idbThumbBytes} previewBytes=${r.idbPreviewBytes} total=${(((r.idbThumbBytes || 0) + (r.idbPreviewBytes || 0)) / 1e6).toFixed(1)}MB quota=${r.idbEstimate ? (r.idbEstimate.quota / 1e9).toFixed(1) + 'GB' : '-'} usage=${r.idbEstimate ? (r.idbEstimate.usage / 1e6).toFixed(1) + 'MB' : '-'} idbError=${r.idbError}`
  );
}
p('');
p('RSS SERIES per run (MB, sampled):');
for (const r of b.runs) p(`  ${r.label}: ${(r.processRss.series || []).join(' ')}`);
p('');
if (b.unboundedControl) p('UNBOUNDED CONTROL: ' + JSON.stringify(b.unboundedControl, null, 1));

const txt = lines.join('\n');
fs.writeFileSync(path.join(OUT, 'summary.txt'), txt);
console.log(txt);
