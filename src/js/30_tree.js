/**
 * @file 30_tree.js
 * @version 1.0
 * @author Samuel Cao
 * @created 2026-07-28
 * @lastUpdated 2026-07-28
 * @description Folder tree model and finalist allocation math for PRD section 4: four allocation states, both math directions, clamping, dead-state detection, and tournament unit derivation.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * This module is pure. It reads photo records and an allocation map and returns a
 * resolution; it never touches the DOM and never mutates its inputs. That is
 * deliberate — the allocation rules are the easiest thing in the PRD to get subtly
 * wrong, and keeping them pure makes them directly testable.
 *
 * THE FOUR STATES (PRD 4.2)
 *   fixed     a number >= 1   parent: children must sum to this   leaf: exactly this many
 *   excluded  0               entire subtree skipped everywhere
 *   pooled    blank           competes with blank siblings for the parent's remainder
 *   uncapped  "*" or Infinity parent: total floats to sum of children   leaf: cull until satisfied
 *
 * 0 means EXCLUDED, not unlimited (PRD section 10). Every other value counts survivors.
 *
 * DESIGN DECISION NOT IN THE PRD: a folder may hold photos directly AND have
 * subfolders. The PRD's worked example (4.3) only shows leaf folders holding photos.
 * Loose photos in a parent are modelled as a synthetic child node with path
 * "<parent>/loose" so they can carry their own allocation state and compete
 * as an ordinary sibling. Without this they would either be silently unallocatable
 * or would force the parent to be both authoritative and a competitor at once.
 */

(function () {
  'use strict';

  var PT = (window.PT = window.PT || {});

  var LOOSE = '__loose__';
  var LOOSE_LABEL = '(loose files)';

  var MODE = { FIXED: 'fixed', EXCLUDED: 'excluded', POOLED: 'pooled', UNCAPPED: 'uncapped' };

  /* ------------------------------------------------------------------ build */

  /**
   * @param {Array<object>} photos  photo records with .path and .dir
   * @returns {{nodes:Object, rootPath:string, order:Array<string>}}
   */
  function build(photos) {
    var nodes = Object.create(null);

    function ensure(path) {
      if (nodes[path]) return nodes[path];
      var name = path === '' ? '/' : path.slice(path.lastIndexOf('/') + 1);
      var parentPath = path === '' ? null : path.slice(0, Math.max(0, path.lastIndexOf('/')));
      var n = {
        path: path,
        name: name === LOOSE ? LOOSE_LABEL : name,
        parentPath: path === '' ? null : parentPath,
        childPaths: [],
        photoIds: [],
        synthetic: name === LOOSE
      };
      nodes[path] = n;
      if (path !== '') {
        var p = ensure(parentPath);
        if (p.childPaths.indexOf(path) < 0) p.childPaths.push(path);
      }
      return n;
    }

    ensure('');
    photos.forEach(function (p) {
      ensure(p.dir).photoIds.push(p.id);
    });

    // Any node holding both direct photos and subfolders gets its loose photos
    // moved into a synthetic child so every competitor in a pool is a node.
    Object.keys(nodes).forEach(function (path) {
      var n = nodes[path];
      if (n.photoIds.length && n.childPaths.length && !n.synthetic) {
        var lp = (path === '' ? '' : path) + '/' + LOOSE;
        var loose = ensure(lp);
        loose.photoIds = n.photoIds;
        n.photoIds = [];
      }
    });

    var order = [];
    (function walk(path) {
      order.push(path);
      nodes[path].childPaths
        .slice()
        .sort(function (a, b) {
          // Synthetic loose nodes sort last so they read as an addendum.
          var as = nodes[a].synthetic, bs = nodes[b].synthetic;
          if (as !== bs) return as ? 1 : -1;
          return a.localeCompare(b, undefined, { numeric: true });
        })
        .forEach(walk);
    })('');

    Object.keys(nodes).forEach(function (path) {
      nodes[path].childPaths.sort(function (a, b) {
        var as = nodes[a].synthetic, bs = nodes[b].synthetic;
        if (as !== bs) return as ? 1 : -1;
        return a.localeCompare(b, undefined, { numeric: true });
      });
    });

    return { nodes: nodes, rootPath: '', order: order };
  }

  /* ------------------------------------------------------------ alloc input */

  /**
   * Parses what the user typed into an allocation state.
   * @param {string|number|null} raw
   * @returns {{mode:string, value:number|null}|null}  null means the input is invalid
   */
  function parseAlloc(raw) {
    if (raw === null || raw === undefined) return { mode: MODE.POOLED, value: null };
    var s = String(raw).trim();
    if (s === '') return { mode: MODE.POOLED, value: null };
    if (s === '*' || s === '∞' || s.toLowerCase() === 'inf') return { mode: MODE.UNCAPPED, value: null };
    if (!/^\d+$/.test(s)) return null;
    var n = parseInt(s, 10);
    if (n === 0) return { mode: MODE.EXCLUDED, value: 0 };
    return { mode: MODE.FIXED, value: n };
  }

  function allocToInput(alloc) {
    if (!alloc) return '';
    if (alloc.mode === MODE.UNCAPPED) return '*';
    if (alloc.mode === MODE.EXCLUDED) return '0';
    if (alloc.mode === MODE.FIXED) return String(alloc.value);
    return '';
  }

  /* ---------------------------------------------------------------- resolve */

  /**
   * The whole of PRD section 4 in one pass.
   *
   * @param {object} tree   from build()
   * @param {Object<string,{mode:string,value:number|null}>} allocs  path -> state
   * @returns {{
   *   nodes: Object,          per-path derived facts
   *   issues: Array<object>,  {path, level:'error'|'warn'|'note', code, message}
   *   units: Array<object>,   tournament units
   *   projectedTotal: number|null,
   *   hasErrors: boolean
   * }}
   */
  function resolve(tree, allocs) {
    allocs = allocs || {};
    var nodes = tree.nodes;
    var out = Object.create(null);
    var issues = [];

    function allocOf(path) {
      return allocs[path] || { mode: MODE.POOLED, value: null };
    }

    function isExcluded(path) {
      var a = allocOf(path);
      if (a.mode === MODE.EXCLUDED) return true;
      var p = nodes[path].parentPath;
      return p === null ? false : isExcluded(p);
    }

    /**
     * A blank node is only genuinely pooled if it is competing for something.
     * A blank node that merely sits between an allocated ancestor and allocated
     * descendants is a PASS-THROUGH container, not a competitor.
     *
     * Without this distinction, PRD 4.1's "no depth cap" collides with PRD 4.5's
     * dead-state rule: on a tree like a/b/c/d/e/f, allocating the root and the leaf
     * would light up every intermediate folder as a dead pool, which is noise
     * rather than a real problem the user needs to fix.
     */
    function hasAllocatedDescendant(path) {
      var kids = nodes[path].childPaths;
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (out[c].excluded) continue;
        var m = out[c].alloc.mode;
        if (m === MODE.FIXED || m === MODE.UNCAPPED) return true;
        if (hasAllocatedDescendant(c)) return true;
      }
      return false;
    }

    // Pass 1, bottom-up: photo counts, ignoring excluded subtrees entirely
    // (PRD 4.5: not ingested, not hashed, not counted in totals).
    (function count(path) {
      var n = nodes[path];
      var self = allocOf(path).mode === MODE.EXCLUDED;
      var kids = n.childPaths.map(count);
      var total = self ? 0 : n.photoIds.length + kids.reduce(function (a, b) { return a + b; }, 0);
      out[path] = {
        path: path,
        name: n.name,
        alloc: allocOf(path),
        excluded: self || isExcluded(path),
        ownCount: self ? 0 : n.photoIds.length,
        subtreeCount: total,
        childPaths: n.childPaths,
        synthetic: n.synthetic,
        target: null,        // number | null (null = uncapped or no target)
        uncapped: false,
        clamped: false,
        pooledShare: null,   // set on pooled nodes that belong to a pool
        unitId: null
      };
      return total;
    })(tree.rootPath);

    // Pass 2, top-down: resolve targets. A node's meaning depends on its parent's
    // state (PRD 4.4), so this cannot be folded into the bottom-up pass.
    var units = [];

    (function assign(path) {
      var n = nodes[path];
      var o = out[path];
      var a = o.alloc;

      if (o.excluded) {
        o.target = 0;
        n.childPaths.forEach(assign);
        return;
      }

      var kids = n.childPaths.filter(function (c) { return !out[c].excluded; });

      // --- leaf ---------------------------------------------------------
      if (kids.length === 0) {
        if (a.mode === MODE.UNCAPPED) {
          o.uncapped = true;
          o.target = null;
          if (o.subtreeCount > 0) {
            units.push(makeUnit('uncapped', path, [path], null, o));
          }
        } else if (a.mode === MODE.FIXED) {
          o.target = Math.min(a.value, o.subtreeCount);
          if (a.value > o.subtreeCount) {
            o.clamped = true;
            issues.push({
              path: path, level: 'warn', code: 'clamped',
              message: 'Asked for ' + a.value + ' but the folder only has ' + o.subtreeCount +
                       '. Clamped to ' + o.target + '.'
            });
          }
          if (o.target > 0) units.push(makeUnit('fixed', path, [path], o.target, o));
        }
        // pooled leaves are claimed by their parent's pool below
        return;
      }

      // --- parent -------------------------------------------------------
      kids.forEach(assign);

      var fixedKids  = kids.filter(function (c) { return out[c].alloc.mode === MODE.FIXED; });
      var uncapKids  = kids.filter(function (c) { return out[c].alloc.mode === MODE.UNCAPPED; });
      var pooledKids = kids.filter(function (c) { return out[c].alloc.mode === MODE.POOLED; });

      var fixedSum = fixedKids.reduce(function (s, c) { return s + (out[c].target || 0); }, 0);

      if (a.mode === MODE.UNCAPPED) {
        // Children are authoritative; the parent total is computed and read-only.
        o.uncapped = true;
        o.target = null;
        // PRD 4.5: pooled under uncapped has no remainder to compete for. Dead
        // state — but only for genuine competitors, not pass-through containers.
        pooledKids.forEach(function (c) {
          if (hasAllocatedDescendant(c)) return;
          issues.push({
            path: c, level: 'error', code: 'dead-pool',
            message: 'Pooled under an uncapped parent, so there is no remainder to compete for. ' +
                     'Give it a count, or set ' + (nodes[path].name || 'the parent') + ' to a fixed number.'
          });
        });
        return;
      }

      if (a.mode === MODE.FIXED) {
        if (fixedSum > a.value) {
          issues.push({
            path: path, level: 'error', code: 'oversubscribed',
            message: 'Children are fixed at ' + fixedSum + ', which is more than this folder’s ' +
                     a.value + '. Lower a child, or set this folder to uncapped (*).'
          });
          o.target = a.value;
          return;
        }
        if (uncapKids.length) {
          issues.push({
            path: path, level: 'error', code: 'uncapped-under-fixed',
            message: 'An uncapped child has no target, so this folder’s fixed total of ' + a.value +
                     ' cannot be honoured. Set this folder to uncapped (*), or give the child a number.'
          });
        }

        var remainder = a.value - fixedSum;
        o.target = a.value;

        if (pooledKids.length) {
          var poolCount = pooledKids.reduce(function (s, c) { return s + out[c].subtreeCount; }, 0);
          var share = Math.min(remainder, poolCount);
          if (remainder > poolCount) {
            issues.push({
              path: path, level: 'warn', code: 'pool-clamped',
              message: 'The pooled folders hold ' + poolCount + ' photos but ' + remainder +
                       ' places are open. Only ' + poolCount + ' can survive.'
            });
          }
          if (share > 0) {
            var u = makeUnit('pooled', path, pooledKids.slice(), share, o);
            units.push(u);
            pooledKids.forEach(function (c) { out[c].pooledShare = u.id; out[c].unitId = u.id; });
          } else {
            pooledKids.forEach(function (c) {
              issues.push({
                path: c, level: 'warn', code: 'no-remainder',
                message: 'Nothing left to compete for — the fixed siblings already use all ' +
                         a.value + ' places.'
              });
            });
          }
        } else if (remainder > 0) {
          // PRD 4.5: every child fixed under a fixed parent leaves no pooled remainder.
          issues.push({
            path: path, level: 'note', code: 'unused-remainder',
            message: 'Every child has a fixed count summing to ' + fixedSum + ', so ' + remainder +
                     ' of this folder’s ' + a.value + ' places will go unused.'
          });
        }
        return;
      }

      // Pooled parent: it is itself a competitor in its own parent's pool, so its
      // target is decided one level up. Its pooled children have no independent
      // remainder, which the grandparent's pool already accounts for.
      o.target = null;
    })(tree.rootPath);

    // Root special case: a pooled root has no parent to allocate it, so treat it
    // as one pool over everything — PRD 4.2's "all children pooled: pure best-of".
    var rootOut = out[tree.rootPath];
    if (!rootOut.excluded && rootOut.alloc.mode === MODE.POOLED && !units.length && rootOut.subtreeCount > 0) {
      issues.push({
        path: tree.rootPath, level: 'note', code: 'root-unallocated',
        message: 'Nothing is allocated yet. Give the top folder a number, or a count to at least one subfolder.'
      });
    }

    var projected = units.some(function (u) { return u.target === null; })
      ? null
      : units.reduce(function (s, u) { return s + u.target; }, 0);

    return {
      nodes: out,
      issues: issues,
      units: units,
      projectedTotal: projected,
      hasErrors: issues.some(function (i) { return i.level === 'error'; })
    };

    function makeUnit(kind, ownerPath, memberPaths, target, o) {
      var ids = [];
      memberPaths.forEach(function (mp) { collectIds(mp, ids); });
      var u = {
        id: kind + ':' + (ownerPath || 'root'),
        kind: kind,
        ownerPath: ownerPath,
        memberPaths: memberPaths,
        label: kind === 'pooled'
          ? 'pooled under ' + (nodes[ownerPath].name || 'root')
          : (nodes[ownerPath].name || 'root'),
        target: target,
        photoIds: ids
      };
      if (kind !== 'pooled') o.unitId = u.id;
      return u;
    }

    function collectIds(path, acc) {
      if (out[path].excluded) return;
      nodes[path].photoIds.forEach(function (id) { acc.push(id); });
      nodes[path].childPaths.forEach(function (c) { collectIds(c, acc); });
    }
  }

  /* ------------------------------------------------------------- distribute */

  /**
   * Top-down suggestion for a fixed parent (PRD 4.4). Default is weighted by photo
   * count; even split is offered. The result is a suggestion the user may edit per
   * child, never an applied value.
   *
   * Largest-remainder apportionment, so the parts sum exactly to the total rather
   * than drifting by a photo or two after rounding.
   *
   * @returns {Object<string,number>} childPath -> suggested count
   */
  function distribute(tree, resolution, parentPath, total, mode) {
    var kids = tree.nodes[parentPath].childPaths.filter(function (c) {
      return !resolution.nodes[c].excluded && resolution.nodes[c].subtreeCount > 0;
    });
    if (!kids.length) return {};

    var caps = kids.map(function (c) { return resolution.nodes[c].subtreeCount; });
    var weights = mode === 'even' ? kids.map(function () { return 1; }) : caps.slice();
    var wsum = weights.reduce(function (a, b) { return a + b; }, 0) || 1;

    var exact = weights.map(function (w) { return (total * w) / wsum; });
    var base = exact.map(function (x) { return Math.floor(x); });
    var used = base.reduce(function (a, b) { return a + b; }, 0);

    var order = kids
      .map(function (c, i) { return { i: i, frac: exact[i] - base[i] }; })
      .sort(function (a, b) { return b.frac - a.frac; });

    var left = total - used;
    for (var k = 0; k < order.length && left > 0; k++) { base[order[k].i]++; left--; }

    // Never suggest more finalists than a folder has photos; push the excess to
    // folders that can still absorb it.
    var overflow = 0;
    base.forEach(function (v, i) {
      if (v > caps[i]) { overflow += v - caps[i]; base[i] = caps[i]; }
    });
    // Keep redistributing until the excess is placed or every folder is at
    // capacity. A bounded number of passes is not enough: pushing 8 surplus
    // places onto one folder needs 8 increments, not one per pass.
    while (overflow > 0) {
      var placed = 0;
      for (var i = 0; i < kids.length && overflow > 0; i++) {
        if (base[i] < caps[i]) { base[i]++; overflow--; placed++; }
      }
      if (!placed) break; // every folder is full; the total is simply unreachable
    }

    var res = {};
    kids.forEach(function (c, i) { res[c] = base[i]; });
    return res;
  }

  /* ------------------------------------------------------------------- api */

  PT.tree = {
    MODE: MODE,
    LOOSE: LOOSE,
    build: build,
    parseAlloc: parseAlloc,
    allocToInput: allocToInput,
    resolve: resolve,
    distribute: distribute
  };
})();

/** CHANGELOG
 * v1.0 (2026-07-28): Initial release. Tree construction with synthetic nodes for
 *   loose files, allocation parsing for all four states, two-pass resolution with
 *   clamping and dead-state detection, tournament unit derivation, and
 *   largest-remainder weighted distribution.
 */
