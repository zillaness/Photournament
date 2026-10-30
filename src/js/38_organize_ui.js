/**
 * @file 38_organize_ui.js
 * @version 1.0
 * @author Samuel Cao
 * @created 2026-10-30
 * @lastUpdated 2026-10-30
 * @description PRD 7.12 "Organize by" control: the category chip row (choose, order, remove), the event-gap and location-radius options, and the naming dialog for events and places. Shared by Sort mode and the culling allocation screen.
 * @aiUpdate Update @lastUpdated and @version. Append changelog at bottom.
 *
 * One control, two homes, so the two modes cannot drift into two meanings of
 * "organize by". It owns no state: it reads a spec through a getter and hands
 * every change to onChange, and the screen decides what a change costs (the
 * allocation screen warns that set counts will reset; Sort mode just redraws).
 */

(function () {
  'use strict';

  var PT = (window.PT = window.PT || {});
  var el = function () { return PT.dom.el.apply(null, arguments); };

  function gapText(h) { return h < 1 ? Math.round(h * 60) + ' min' : h + ' h'; }

  /**
   * @param {{
   *   spec: function():object,            current organize spec
   *   photos: function():object[],        live photo records
   *   onChange: function(object):void,    receives the next spec
   *   locked?: string                     when set, the reason it cannot change
   * }} opts
   * @returns {{el:HTMLElement, refresh:function()}}
   */
  function organizeBar(opts) {
    var root = el('div', { class: 'org-bar', dataset: { t: 'org-bar' } });

    function emit(mut) {
      var cur = PT.organize.normSpec(opts.spec());
      var next = { cats: cur.cats.slice(), eventGapH: cur.eventGapH, radiusKm: cur.radiusKm, names: Object.assign({}, cur.names) };
      mut(next);
      opts.onChange(next);
    }

    function render() {
      PT.dom.clear(root);
      var spec = PT.organize.normSpec(opts.spec());
      var photos = opts.photos() || [];
      var pl = PT.organize.plan(photos, spec);
      var locked = opts.locked;

      var chosen = el('div', { class: 'org-chosen' }, [el('span', { class: 'org-label', text: 'Organize by' })]);
      if (!spec.cats.length) chosen.appendChild(el('span', { class: 'small dim', text: 'nothing yet: everything in one group' }));
      spec.cats.forEach(function (key, i) {
        var cat = PT.organize.CATEGORIES.filter(function (c) { return c.key === key; })[0];
        if (i) chosen.appendChild(el('span', { class: 'org-sep', text: '›' }));
        chosen.appendChild(el('span', { class: 'org-chip on', dataset: { t: 'org-chosen', cat: key }, title: cat.hint }, [
          i > 0 && !locked ? el('button', { type: 'button', class: 'org-mini', text: '←', title: 'Move up a level',
            dataset: { t: 'org-left' },
            onclick: function () { emit(function (n) { var t = n.cats[i - 1]; n.cats[i - 1] = n.cats[i]; n.cats[i] = t; }); } }) : null,
          el('span', { text: cat.label }),
          !locked ? el('button', { type: 'button', class: 'org-mini', text: '×', title: 'Stop organizing by ' + cat.label.toLowerCase(),
            dataset: { t: 'org-remove' },
            onclick: function () { emit(function (n) { n.cats.splice(i, 1); }); } }) : null
        ]));
      });
      root.appendChild(chosen);

      if (locked) {
        root.appendChild(el('div', { class: 'small dim', text: locked }));
      } else {
        var add = el('div', { class: 'org-add' }, [el('span', { class: 'org-label', text: spec.cats.length ? 'then' : 'Add' })]);
        PT.organize.CATEGORIES.forEach(function (c) {
          if (spec.cats.indexOf(c.key) >= 0) return;
          var sm = pl.summary[c.key];
          // A category that puts every photo in one bucket organizes nothing;
          // it stays offered, but says so, rather than vanishing unexplained.
          var only = sm.groups <= 1;
          add.appendChild(el('button', {
            type: 'button', class: 'org-chip' + (only ? ' flat' : ''),
            dataset: { t: 'org-add', cat: c.key },
            title: c.hint + ' — ' + sm.groups + ' group' + (sm.groups === 1 ? '' : 's') +
              (sm.missing ? ', ' + sm.missing + ' photo' + (sm.missing === 1 ? '' : 's') + ' without it' : ''),
            onclick: function () { emit(function (n) { n.cats.push(c.key); }); }
          }, [c.label, el('span', { class: 'org-n nums', text: String(sm.groups) })]));
        });
        root.appendChild(add);
      }

      // Options only for what is chosen, and naming only where names are made up.
      var optsRow = el('div', { class: 'org-opts' });
      if (spec.cats.indexOf('event') >= 0) {
        var gap = el('select', { dataset: { t: 'org-gap' }, disabled: !!locked });
        PT.organize.GAP_CHOICES.forEach(function (h) {
          var o = el('option', { value: String(h), text: 'new event after ' + gapText(h) + ' without a photo' });
          if (h === spec.eventGapH) o.selected = true;
          gap.appendChild(o);
        });
        gap.addEventListener('change', function () { emit(function (n) { n.eventGapH = +gap.value; }); });
        optsRow.appendChild(el('label', { class: 'small' }, [el('span', { class: 'dim', text: 'Events: ' }), gap]));
      }
      if (spec.cats.indexOf('location') >= 0) {
        var rad = el('select', { dataset: { t: 'org-radius' }, disabled: !!locked });
        PT.organize.RADIUS_CHOICES.forEach(function (k) {
          var o = el('option', { value: String(k), text: 'photos within ' + k + ' km are one place' });
          if (k === spec.radiusKm) o.selected = true;
          rad.appendChild(o);
        });
        rad.addEventListener('change', function () { emit(function (n) { n.radiusKm = +rad.value; }); });
        optsRow.appendChild(el('label', { class: 'small' }, [el('span', { class: 'dim', text: 'Places: ' }), rad]));
      }
      var nameable = (spec.cats.indexOf('event') >= 0 && pl.events.length) || (spec.cats.indexOf('location') >= 0 && pl.locations.length);
      if (nameable && !locked) {
        optsRow.appendChild(el('button', { type: 'button', class: 'btn btn-sm', text: 'Name events and places…',
          dataset: { t: 'org-name' }, onclick: function () { nameDialog(spec, pl); } }));
      }
      if (optsRow.childNodes.length) root.appendChild(optsRow);

      var notes = [];
      if (pl.noCapture) {
        notes.push(pl.noCapture + ' photo' + (pl.noCapture === 1 ? ' was' : 's were') +
          ' read before Photournament kept metadata, so ' + (pl.noCapture === 1 ? 'it lands' : 'they land') +
          ' in the "unknown" groups. Adding the folder again reads it.');
      }
      spec.cats.forEach(function (k) {
        var sm = pl.summary[k];
        if (k !== 'folder' && sm.missing && sm.missing < photos.length) {
          var cat = PT.organize.CATEGORIES.filter(function (c) { return c.key === k; })[0];
          notes.push(sm.missing + ' without ' + cat.label.toLowerCase() + ' information go to their own group.');
        }
      });
      if (notes.length) root.appendChild(el('div', { class: 'small dim org-notes', text: notes.join(' ') }));
    }

    /**
     * Events and places are the two categories whose names are made up
     * ("2026-07-14 09.12", "Near 35.01N 135.77E"), so they are the two that
     * can be renamed. A name is saved on the spec, keyed so it survives a
     * change of gap or radius (PT.organize matches places by distance).
     */
    function nameDialog(spec, pl) {
      var body = PT.dom.$('#modal-body');
      var dlg = PT.dom.$('#modal');
      if (!body || !dlg) return;
      PT.dom.clear(body);
      body.appendChild(el('h2', { text: 'Name events and places' }));
      body.appendChild(el('p', { class: 'muted small', text:
        'Names become folder names when you export. Leave one blank to keep its automatic name.' }));
      var inputs = [];
      function section(title, list, fmt) {
        if (!list.length) return;
        body.appendChild(el('h3', { class: 'org-h3', text: title }));
        var box = el('div', { class: 'org-names' });
        list.forEach(function (g) {
          var input = el('input', { type: 'text', maxlength: '60', placeholder: g.auto, dataset: { t: 'org-name-input', key: g.key } });
          input.value = spec.names[g.key] || '';
          inputs.push(input);
          box.appendChild(el('label', { class: 'row' }, [
            el('span', { class: 'small dim org-name-what', text: fmt(g) }),
            input
          ]));
        });
        body.appendChild(box);
      }
      if (spec.cats.indexOf('event') >= 0) {
        section('Events', pl.events, function (g) { return g.auto + ' · ' + g.count + ' photo' + (g.count === 1 ? '' : 's'); });
      }
      if (spec.cats.indexOf('location') >= 0) {
        section('Places from GPS', pl.locations, function (g) {
          return g.lat.toFixed(3) + ', ' + g.lon.toFixed(3) + ' · ' + g.count + ' photo' + (g.count === 1 ? '' : 's');
        });
      }
      body.appendChild(el('div', { class: 'row', style: 'margin-top:14px' }, [
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: function () { dlg.close(); } }),
        el('button', { class: 'btn btn-primary', type: 'button', text: 'Save names', dataset: { t: 'org-name-save' },
          onclick: function () {
            emit(function (n) {
              inputs.forEach(function (i) {
                var v = i.value.trim();
                if (v) n.names[i.dataset.key] = v; else delete n.names[i.dataset.key];
              });
            });
            dlg.close();
          } })
      ]));
      if (!dlg.open) dlg.showModal();
    }

    render();
    return { el: root, refresh: render };
  }

  PT.organizeBar = organizeBar;
})();

/*
CHANGELOG
v1.0 (2026-10-30): Initial release (PRD 7.12 draft). Chosen chips with
  reorder and remove, add chips with live group counts, event-gap and
  location-radius options, missing-data notes, and the event/place naming
  dialog.
*/
