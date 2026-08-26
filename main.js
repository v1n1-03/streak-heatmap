const { Plugin } = require('obsidian');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_LABELS = { 1: 'Mon', 3: 'Wed', 5: 'Fri' }; // grid rows are Sun(0)..Sat(6); only every other row is labeled to save space
const MAX_PAST_YEARS = 6; // cap on how many past-year buttons can appear, so the row doesn't grow unbounded

module.exports = class StreakHeatmapPlugin extends Plugin {
  async onload() {
    try {
      this.data = (await this.loadData()) || {};
    } catch (e) {
      console.error('Streak Heatmap: failed to load saved data', e);
      this.data = {};
    }

    this.registerMarkdownCodeBlockProcessor('streak', (source, el) => {
      this.renderHeatmap(source, el);
    });
  }

  parseParams(source) {
    const params = {};
    source.split('\n').forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > -1) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k) params[k] = v;
      }
    });
    return params;
  }

  // Formats a date as YYYY-MM-DD from its LOCAL components. Deliberately
  // avoids toISOString(), which converts to UTC and can shift the date near
  // midnight in timezones ahead of UTC (e.g. marking "today" at 11pm in
  // Japan would otherwise save the wrong day).
  dateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // Builds a week grid that always spans Jan 1 - Dec 31 of the given year,
  // aligned to Sunday. This leaves a few filler days from the previous/next
  // year at each end of the grid; those are handled as non-interactive
  // filler cells in renderGrid so data never crosses into another year.
  buildWeeks(year) {
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);
    const gridStart = new Date(start);
    gridStart.setDate(start.getDate() - start.getDay());

    const weeks = [];
    let cursor = new Date(gridStart);
    while (cursor <= end) {
      const week = [];
      for (let i = 0; i < 7; i++) {
        week.push(new Date(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(week);
    }
    return weeks;
  }

  renderGrid(gridArea, trackerData, year, today, dims) {
    const { CELL, GAP, COL } = dims;
    const todayStr = this.dateStr(today);
    const weeks = this.buildWeeks(year);

    const monthRow = gridArea.createDiv({ cls: 'streak-heatmap-months' });
    monthRow.style.display = 'grid';
    monthRow.style.gridTemplateColumns = `repeat(${weeks.length}, ${COL}px)`;
    monthRow.style.marginLeft = `${COL + 4}px`;
    weeks.forEach((week) => {
      const cell = monthRow.createDiv({ cls: 'streak-heatmap-month-label' });
      // Only a "day 1" that belongs to the displayed year counts here, so
      // filler days at the grid's edges don't get mislabeled with the wrong month.
      const firstOfMonth = week.find((d) => d.getDate() === 1 && d.getFullYear() === year);
      cell.setText(firstOfMonth ? MONTH_NAMES[firstOfMonth.getMonth()] : '');
    });

    const body = gridArea.createDiv({ cls: 'streak-heatmap-body' });
    body.style.display = 'flex';

    const dayLabelsCol = body.createDiv({ cls: 'streak-heatmap-daylabels' });
    dayLabelsCol.style.display = 'grid';
    dayLabelsCol.style.gridTemplateRows = `repeat(7, ${COL}px)`;
    dayLabelsCol.style.width = `${COL}px`;
    for (let row = 0; row < 7; row++) {
      dayLabelsCol.createDiv({ cls: 'streak-heatmap-day-label' }).setText(DAY_LABELS[row] || '');
    }

    const grid = body.createDiv({ cls: 'streak-heatmap-grid' });
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = `repeat(${weeks.length}, ${CELL}px)`;
    grid.style.gridAutoFlow = 'column';
    grid.style.gridTemplateRows = `repeat(7, ${CELL}px)`;
    grid.style.gap = `${GAP}px`;

    const cellByDate = {};

    // Every UI element tied to a given date (its cell, and — for today —
    // the "Mark today" button) registers a listener here instead of
    // updating itself directly. This way a single toggleDate() call keeps
    // every element for that date in sync, no matter which one was clicked.
    const listenersByDate = {};
    const onDateChange = (ds, fn) => {
      if (!listenersByDate[ds]) listenersByDate[ds] = [];
      listenersByDate[ds].push(fn);
    };
    const notifyDateChange = (ds) => {
      const isMarked = !!trackerData[ds];
      (listenersByDate[ds] || []).forEach((fn) => fn(isMarked));
    };

    const toggleDate = async (ds) => {
      if (trackerData[ds]) {
        delete trackerData[ds];
      } else {
        trackerData[ds] = true;
      }
      notifyDateChange(ds);
      try {
        await this.saveData(this.data);
      } catch (e) {
        console.error('Streak Heatmap: failed to save data', e);
      }
    };

    weeks.forEach((week) => {
      week.forEach((date) => {
        // Filler days at the grid's edges (late December of the previous
        // year, early January of the next) only take up space. They are
        // never clickable and never touch trackerData, so a streak can't
        // end up saved under the wrong year.
        if (date.getFullYear() !== year) {
          const filler = grid.createDiv();
          filler.style.width = `${CELL}px`;
          filler.style.height = `${CELL}px`;
          return;
        }

        const ds = this.dateStr(date);
        const marked = !!trackerData[ds];
        const isFuture = ds > todayStr;

        const cell = grid.createDiv({ cls: 'streak-heatmap-cell' });
        cell.style.width = `${CELL}px`;
        cell.style.height = `${CELL}px`;
        cell.style.borderRadius = '3px';
        cell.classList.toggle('is-marked', marked);

        if (isFuture) {
          // Future day: shown faded and non-interactive, since a streak
          // can't be logged for a day that hasn't happened yet.
          cell.classList.add('is-future');
          return;
        }

        cellByDate[ds] = cell;
        cell.setAttr('title', ds);
        cell.setAttr('role', 'button');
        cell.setAttr('tabindex', '0');
        cell.setAttr('aria-label', ds);
        cell.setAttr('aria-pressed', String(marked));

        onDateChange(ds, (isMarked) => {
          cell.classList.toggle('is-marked', isMarked);
          cell.setAttr('aria-pressed', String(isMarked));
        });

        cell.onclick = () => toggleDate(ds);
        cell.onkeydown = (evt) => {
          if (evt.key === 'Enter' || evt.key === ' ') {
            evt.preventDefault();
            toggleDate(ds);
          }
        };
      });
    });

    if (cellByDate[todayStr]) {
      const btnRow = gridArea.createDiv({ cls: 'streak-heatmap-btnrow' });
      const btn = btnRow.createEl('button', { text: 'Mark today' });
      const updateLabel = (isMarked) => {
        btn.setText(isMarked ? 'Unmark today' : 'Mark today');
        btn.setAttr('aria-pressed', String(isMarked));
      };
      updateLabel(!!trackerData[todayStr]);
      onDateChange(todayStr, updateLabel);
      btn.onclick = () => toggleDate(todayStr);
    }
  }

  renderHeatmap(source, el) {
    const params = this.parseParams(source);
    const title = params.title; // optional board name; also used as the storage key

    const key = title ? title.toLowerCase().replace(/\s+/g, '-') : 'default';
    if (!this.data[key]) this.data[key] = {};
    const trackerData = this.data[key];

    const dims = { CELL: 20, GAP: 4, COL: 24 };

    const container = el.createDiv({ cls: 'streak-heatmap-container' });
    if (title) container.createEl('h4', { text: title });

    const today = new Date();
    const currentYear = today.getFullYear();

    // Finds the earliest year with any marked day, to decide how many year
    // buttons to show. With no history yet, only one (empty) past year is
    // shown; buttons for older years appear automatically as data reaches
    // further back, up to MAX_PAST_YEARS.
    let minDataYear = currentYear;
    Object.keys(trackerData).forEach((ds) => {
      const y = parseInt(ds.slice(0, 4), 10);
      if (y < minDataYear) minDataYear = y;
    });
    const pastYearsToShow = Math.min(MAX_PAST_YEARS, Math.max(1, currentYear - minDataYear));

    const yearRow = container.createDiv({ cls: 'streak-heatmap-years' });
    const gridArea = container.createDiv({ cls: 'streak-heatmap-gridarea' });

    let selectedYear = currentYear;
    const buttons = [];

    const draw = () => {
      gridArea.empty();
      this.renderGrid(gridArea, trackerData, selectedYear, today, dims);
      buttons.forEach(({ btn, year }) => {
        const active = year === selectedYear;
        btn.classList.toggle('is-active', active);
        btn.setAttr('aria-pressed', String(active));
      });
    };

    const makeYearBtn = (year) => {
      const btn = yearRow.createEl('button', { text: String(year), cls: 'streak-heatmap-year-btn' });
      btn.onclick = () => {
        selectedYear = year;
        draw();
      };
      buttons.push({ btn, year });
    };

    makeYearBtn(currentYear);
    for (let i = 1; i <= pastYearsToShow; i++) {
      makeYearBtn(currentYear - i);
    }

    draw();
  }
};
