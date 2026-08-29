const { Plugin, MarkdownRenderChild, moment } = require('obsidian');

const MAX_PAST_YEARS = 6;
const SAVE_DEBOUNCE_MS = 300;
const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;
const MAX_POINTS = 9999;
const MAX_CACHE_SIZE = 200;
const MAX_FILE_CACHE_SIZE = 100;
const MAX_INPUT_CHARS = 4;

module.exports = class StreakHeatmapPlugin extends Plugin {
  async onload() {
    this.colorCache = Object.create(null);
    this.heatmapContexts = new Map();
    this.fileCaches = new Map();
    this.processingFiles = new Set();
    this.pendingRetry = new Set();
    this.activePopup = null;
    this.popupTimers = null;
    this._saveTimer = null;
    this._saving = false;
    this._saveAgain = false;
    this._savePromise = Promise.resolve();
    this.weeksCache = new Map();
    this._resizeTimer = null;

    let needsMigration = false;
    try {
      this.data = (await this.loadData()) || {};
      needsMigration = this.normalizeData();
    } catch (e) {
      console.error('Streak Heatmap: failed to load saved data', e);
      this.data = Object.create(null);
    }

    this.registerEvent(this.app.workspace.on('file-open', (file) => this.cacheDetailedFile(file)));
    this.registerEvent(this.app.vault.on('modify', (file) => this.processFileModify(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      const cachedText = this.fileCaches.get(oldPath);
      if (cachedText !== undefined) {
        this.fileCaches.delete(oldPath);
        this.fileCaches.set(file.path, cachedText);
      }
      this.heatmapContexts.forEach((context) => {
        if (context.path === oldPath) context.path = file.path;
      });
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => this.fileCaches.delete(file.path)));

    this.registerDomEvent(document, 'click', (event) => {
      if (this.activePopup && !this.activePopup.contains(event.target)) this.closePopup();
    });
    this.registerDomEvent(document, 'touchstart', (event) => {
      if (this.activePopup && !this.activePopup.contains(event.target)) this.closePopup();
    }, { passive: true });
    this.registerDomEvent(document, 'keydown', (event) => {
      if (event.key !== 'Escape' || !this.activePopup) return;
      const triggerCell = this.activePopup.triggerCell;
      this.closePopup();
      if (triggerCell && triggerCell.isConnected) triggerCell.focus();
    });

    this.registerEvent(this.app.workspace.on('layout-change', () => {
      this.heatmapContexts.forEach((context) => {
        if (context.el.isConnected) context.draw();
      });
    }));

    this.registerDomEvent(window, 'resize', () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._resizeTimer = null;
        this.heatmapContexts.forEach((context) => {
          if (context.el.isConnected) context.draw();
        });
      }, 150);
    });
    this.register(() => clearTimeout(this._resizeTimer));

    this.registerMarkdownCodeBlockProcessor('streak', (source, el, ctx) => {
      this.renderHeatmap(source, el, ctx);
    });

    this.register(() => clearTimeout(this._saveTimer));
    if (needsMigration) this.scheduleSave();
  }

  async onunload() {
    const hadTimer = this._saveTimer !== null;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this.closePopup();
    if (hadTimer || this._saving) {
      try {
        await this.flushSave();
      } catch (e) {
        console.error('Streak Heatmap: failed to save data on unload', e);
      }
    }
  }

  parseParams(source) {
    const params = Object.create(null);
    const validStats = ['bar', 'text', 'none'];
    const validModes = ['simple', 'detailed'];
    
    if (!source || typeof source !== 'string') return params;
    
    source.split('\n').forEach((line) => {
      if (!line || typeof line !== 'string') return;
      const idx = line.indexOf(':');
      if (idx > -1) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        
        if (!key) return;
        
        if (key === 'title') {
          params[key] = value;
        } else if (key === 'color') {
          params[key] = value;
        } else if (key === 'stats') {
          if (validStats.includes(value)) params[key] = value;
          else console.warn(`Streak Heatmap: invalid stats value "${value}", using default`);
        } else if (key === 'mode') {
          if (validModes.includes(value)) params[key] = value;
          else console.warn(`Streak Heatmap: invalid mode value "${value}", using default`);
        }
      }
    });
    return params;
  }

  generateId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  normalizePoints(value) {
    if (value === true) return 1;
    if (value === null || value === undefined) return 0;
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value > MAX_POINTS) {
      console.warn(`Streak Heatmap: points exceed MAX_POINTS (${MAX_POINTS}), clamping to max`);
      return MAX_POINTS;
    }
    return Math.floor(value);
  }

  normalizeData() {
    if (!this.data || typeof this.data !== 'object' || Array.isArray(this.data)) {
      this.data = Object.create(null);
      return true;
    }

    let changed = false;
    if (Object.getPrototypeOf(this.data) !== null) {
      Object.setPrototypeOf(this.data, null);
      changed = true;
    }

    Object.entries(this.data).forEach(([key, trackerData]) => {
      if (!trackerData || typeof trackerData !== 'object' || Array.isArray(trackerData)) {
        delete this.data[key];
        changed = true;
        return;
      }

      if (Object.getPrototypeOf(trackerData) !== null) {
        Object.setPrototypeOf(trackerData, null);
        changed = true;
      }
      Object.entries(trackerData).forEach(([date, value]) => {
        if (!this.isValidDateString(date)) {
          delete trackerData[date];
          changed = true;
          return;
        }
        const points = this.normalizePoints(value);
        if (points > 0) trackerData[date] = points;
        else delete trackerData[date];
        if (points !== value) changed = true;
      });
    });
    return changed;
  }

  getTrackerData(key) {
    if (!Object.prototype.hasOwnProperty.call(this.data, key)
      || !this.data[key]
      || typeof this.data[key] !== 'object'
      || Array.isArray(this.data[key])) {
      this.data[key] = Object.create(null);
    }
    return this.data[key];
  }

  normalizeColor(value) {
    const cacheKey = value || '';
    if (Object.prototype.hasOwnProperty.call(this.colorCache, cacheKey)) return this.colorCache[cacheKey];
    
    const cacheKeys = Object.keys(this.colorCache);
    if (cacheKeys.length >= MAX_CACHE_SIZE) {
      const keysArray = cacheKeys.sort();
      delete this.colorCache[keysArray[0]];
    }

    const cache = (result) => {
      this.colorCache[cacheKey] = result;
      return result;
    };
    if (!value) return cache(null);

    let trimmed = value.trim();
    const rgbNumbersMatch = trimmed.match(/^\s*\(?\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)?\s*$/);
    if (rgbNumbersMatch) {
      trimmed = `rgb(${rgbNumbersMatch[1]}, ${rgbNumbersMatch[2]}, ${rgbNumbersMatch[3]})`;
    }

    if (trimmed.startsWith('--') && !/^--[a-zA-Z0-9_-]+$/.test(trimmed)) return cache(null);
    const color = trimmed.startsWith('--') ? `var(${trimmed})` : trimmed;
    
    try {
      if (typeof CSS !== 'undefined' && CSS.supports && !CSS.supports('background-color', color)) return cache(null);
    } catch (e) {
      return cache(null);
    }

    if (!this._colorProbe) {
      this._colorProbe = document.createElement('span');
      this._colorProbe.style.position = 'absolute';
      this._colorProbe.style.visibility = 'hidden';
      this._colorProbe.style.pointerEvents = 'none';
      document.body.appendChild(this._colorProbe);
      this.register(() => this._colorProbe.remove());
    }

    const probe = this._colorProbe;
    probe.style.backgroundColor = '';
    try {
      probe.style.backgroundColor = color;
      if (!probe.style.backgroundColor) return cache(null);
      const computedColor = getComputedStyle(probe).backgroundColor;
      if (color.includes('var(') && /^(transparent|rgba?\(0, 0, 0, 0\))$/i.test(computedColor)) return cache(null);
      return cache(computedColor ? color : null);
    } catch (e) {
      return cache(null);
    }
  }

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  async flushSave() {
    if (this._saving) {
      this._saveAgain = true;
    } else {
      this._saving = true;
      this._savePromise = this._writeData();
    }
    while (this._saving) await this._savePromise;
  }

  async _writeData() {
    try {
      this.normalizeData();
      await this.saveData(this.data);
    } catch (e) {
      console.error('Streak Heatmap: failed to save data', e);
    } finally {
      if (this._saveAgain) {
        this._saveAgain = false;
        this._savePromise = this._writeData();
      } else {
        this._saving = false;
      }
    }
  }

  closePopup() {
    if (this.activePopup) {
      if (this.activePopup.cleanupListeners) {
        this.activePopup.cleanupListeners();
      }
      this.activePopup.remove();
    }
    this.activePopup = null;
    this.clearPopupTimers();
  }

  clearPopupTimers() {
    if (!this.popupTimers) return;
    clearTimeout(this.popupTimers.delay);
    clearInterval(this.popupTimers.interval);
    this.popupTimers = null;
  }

  refreshContextsForKey(key, excludeId) {
    this.heatmapContexts.forEach((context) => {
      if (context.key === key && context.id !== excludeId) {
        context.draw();
      }
    });
  }

  hasDetailedContextForPath(path) {
    return [...this.heatmapContexts.values()].some((context) => (
      context.mode === 'detailed' && context.path === path
    ));
  }

  async cacheDetailedFile(file) {
    if (!file || file.extension !== 'md' || !this.hasDetailedContextForPath(file.path)) return;
    await this.cacheFile(file);
  }

  async cacheFile(file) {
    if (!file || file.extension !== 'md') return;
    try {
      const text = await this.app.vault.read(file);
      const fileSizeKb = text.length / 1024;
      
      if (fileSizeKb > MAX_FILE_CACHE_SIZE) {
        return;
      }
      
      if (this.fileCaches.size >= MAX_CACHE_SIZE) {
        const firstKey = this.fileCaches.keys().next().value;
        this.fileCaches.delete(firstKey);
      }
      this.fileCaches.set(file.path, text);
    } catch (e) {
      console.error('Streak Heatmap: failed to cache file', file.path, e);
    }
  }

  escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  taskContent(line, checked) {
    if (!line || typeof line !== 'string') return null;
    const state = checked ? '[xX]' : ' ';
    const match = line.match(new RegExp(`^\\s*[-*+]\\s+\\[${state}\\]\\s+(.+)$`));
    return match ? match[1].trim() : null;
  }

  async processFileModify(file) {
    if (!file || file.extension !== 'md' || !file.path) return;
    if (this.processingFiles.has(file.path)) {
      this.pendingRetry.add(file.path);
      return;
    }

    const contexts = [...this.heatmapContexts.values()].filter((context) => (
      context && context.mode === 'detailed'
      && context.path === file.path
      && context.title
    ));
    if (!contexts.length) {
      this.fileCaches.delete(file.path);
      return;
    }

    const previousText = this.fileCaches.get(file.path);
    if (previousText === undefined) {
      await this.cacheFile(file);
      return;
    }

    if (typeof previousText !== 'string') {
      console.warn('Streak Heatmap: cached file text is invalid, clearing cache');
      this.fileCaches.delete(file.path);
      return;
    }

    const prevUnchecked = new Map();
    previousText.split(/\r?\n/).forEach((line) => {
      const content = this.taskContent(line, false);
      if (content) prevUnchecked.set(content, (prevUnchecked.get(content) || 0) + 1);
    });

    this.processingFiles.add(file.path);
    const today = this.dateStr(new Date());
    
    if (!this.isValidDateString(today)) {
      this.processingFiles.delete(file.path);
      return;
    }

    const badgeRegex = new RegExp(`✅\\s*${this.escapeRegExp(today)}(?=\\s|$)`);
    const anyBadgeRegex = /\s*✅\s*\d{4}-\d{2}-\d{2}(?=\s|$)/;
    const pointsByKey = new Map();
    let changed = false;

    const compiledContexts = contexts.map((ctx) => ({
      key: ctx.key,
      regex: new RegExp(`(^|[^\\p{L}\\p{N}])${this.escapeRegExp(ctx.title)}($|[^\\p{L}\\p{N}])`, 'iu')
    }));

    try {
      await this.app.vault.process(file, (data) => {
        const newline = data.includes('\r\n') ? '\r\n' : '\n';
        const updated = data.split(/\r?\n/).map((line) => {
          const rawTitle = this.taskContent(line, true);
          if (rawTitle) {
            if (badgeRegex.test(rawTitle)) return line;

            const remaining = prevUnchecked.get(rawTitle) || 0;
            if (remaining <= 0) return line;
            prevUnchecked.set(rawTitle, remaining - 1);

            const normalizedTitle = rawTitle.toLowerCase();
            const matches = compiledContexts.filter((ctx) => ctx.regex.test(normalizedTitle));
            if (!matches.length) return line;

            const matchedKeys = new Set(matches.map((ctx) => ctx.key));
            matchedKeys.forEach((key) => pointsByKey.set(key, (pointsByKey.get(key) || 0) + 1));
            changed = true;
            return `${line} ✅ ${today}`;
          }

          const uncheckedTitle = this.taskContent(line, false);
          if (uncheckedTitle && anyBadgeRegex.test(line)) {
            changed = true;
            return line.replace(anyBadgeRegex, '');
          }
          return line;
        });
        return changed ? updated.join(newline) : data;
      });

      this.fileCaches.set(file.path, await this.app.vault.read(file));

      if (pointsByKey.size) {
        pointsByKey.forEach((points, key) => {
          const trackerData = this.getTrackerData(key);
          trackerData[today] = Math.min(MAX_POINTS, this.normalizePoints(trackerData[today]) + points);
        });
        pointsByKey.forEach((_, key) => this.refreshContextsForKey(key, null));
        this.scheduleSave();
      }
    } catch (e) {
      console.error('Streak Heatmap: failed to process file', file.path, e);
    } finally {
      this.processingFiles.delete(file.path);
      if (this.pendingRetry.has(file.path)) {
        this.pendingRetry.delete(file.path);
        setTimeout(() => this.processFileModify(file), 100);
      }
    }
  }

  getStats(trackerData, year) {
    const daysInYear = new Date(year, 1, 29).getDate() === 29 ? 366 : 365;
    let total = 0;
    let points = 0;
    let maxStreak = 0;
    let currentStreak = 0;
    const cursor = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);

    while (cursor <= end) {
      const dayPoints = this.normalizePoints(trackerData[this.dateStr(cursor)]);
      if (dayPoints > 0) {
        total += 1;
        points += dayPoints;
        currentStreak += 1;
        maxStreak = Math.max(maxStreak, currentStreak);
      } else {
        currentStreak = 0;
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    const percentage = daysInYear > 0 ? Math.round((total / daysInYear) * 1000) / 10 : 0;
    return { total, points, percentage, maxStreak };
  }

  formatDate(ds, locale) {
    return moment(ds, 'YYYY-MM-DD').locale(locale).format('dddd, LL');
  }

  renderStats(gridArea, trackerData, year, stats, color, mode) {
    if (stats === 'none') return null;

    const statsEl = gridArea.createDiv({ cls: `streak-heatmap-stats is-${stats}` });
    let fill;
    if (stats === 'bar') {
      const track = statsEl.createDiv({ cls: 'streak-heatmap-stats-track' });
      fill = track.createDiv({ cls: 'streak-heatmap-stats-fill' });
      if (color) fill.style.backgroundColor = color;
    }
    const summary = statsEl.createDiv({ cls: 'streak-heatmap-stats-summary' });
    const update = () => {
      const values = this.getStats(trackerData, year);
      const pts = mode === 'detailed' ? ` (${values.points} pts)` : '';
      summary.setText(`${values.total} days${pts} | ${values.percentage}% of year | max streak: ${values.maxStreak} days`);
      if (fill && !Number.isNaN(values.percentage)) {
        fill.style.width = `${Math.min(100, Math.max(0, values.percentage))}%`;
      }
    };
    update();
    return update;
  }

  dateStr(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  isValidDateString(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
    
    const [year, month, day] = dateStr.split('-').map(Number);
    if (year < 1970 || year > 3000) return false;
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return false;
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (date > today) return false;
    
    return true;
  }

  buildWeeks(year) {
    const cacheKey = `weeks-${year}`;
    if (this.weeksCache.has(cacheKey)) {
      return this.weeksCache.get(cacheKey);
    }
    
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);
    const gridStart = new Date(start);
    gridStart.setDate(start.getDate() - start.getDay());

    const weeks = [];
    let cursor = new Date(gridStart);
    while (cursor <= end) {
      const week = [];
      for (let index = 0; index < 7; index += 1) {
        week.push(new Date(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(week);
    }
    this.weeksCache.set(cacheKey, weeks);
    return weeks;
  }

  getResponsiveDims() {
    const width = window.innerWidth;
    if (width <= 320) return { CELL: 14, GAP: 3, COL: 17 };
    if (width <= 480) return { CELL: 16, GAP: 4, COL: 20 };
    return { CELL: 20, GAP: 4, COL: 24 };
  }

  pointLevel(points) {
    if (points === 0) return 0;
    if (points <= 1) return 1;
    if (points <= 3) return 2;
    if (points <= 5) return 3;
    return 4;
  }

  showPointsPopup(position, cell, trackerData, update, popupHost, focusInput, contextId) {
    this.closePopup();

    const date = cell.dataset.date;
    const popup = document.createElement('div');
    popup.className = 'streak-heatmap-popup';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-modal', 'true');
    const titleId = `popup-title-${contextId}`;
    const title = document.createElement('div');
    title.id = titleId;
    title.style.display = 'none';
    title.textContent = `Edit points for ${date}`;
    popup.appendChild(title);
    popup.setAttribute('aria-labelledby', titleId);
    popup.triggerCell = cell;
    popup.contextId = contextId;
    
    const stopPropagation = (e) => e.stopPropagation();
    popup.addEventListener('click', stopPropagation);
    popup.addEventListener('touchstart', stopPropagation, { passive: true });
    
    popupHost.appendChild(popup);

    const minus = document.createElement('button');
    minus.type = 'button';
    minus.textContent = '−';
    minus.setAttribute('aria-label', 'Remove one point');
    minus.setAttribute('title', 'Remove one point');
    popup.appendChild(minus);

    const input = document.createElement('input');
    try {
      input.type = 'number';
      if (input.type !== 'number') {
        input.type = 'text';
        input.pattern = '\\d*';
      }
    } catch (e) {
      input.type = 'text';
      input.pattern = '\\d*';
    }
    input.value = String(this.normalizePoints(trackerData[date]));
    input.min = '0';
    input.max = String(MAX_POINTS);
    input.step = '1';
    input.inputMode = 'numeric';
    input.maxLength = MAX_INPUT_CHARS;
    input.setAttribute('aria-label', `Points for ${date}`);
    
    input.addEventListener('input', (e) => {
      let numVal = e.target.value;
      if (e.target.type === 'text') {
        numVal = numVal.replace(/[^\d]/g, '');
        e.target.value = numVal;
      }
      const val = Math.min(MAX_POINTS, Math.max(0, Number(numVal) || 0));
      if (Number(e.target.value) !== val && e.target.type === 'number') {
        e.target.value = String(val);
      }
    });
    popup.appendChild(input);

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = '+';
    plus.setAttribute('aria-label', 'Add one point');
    plus.setAttribute('title', 'Add one point');
    popup.appendChild(plus);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = '❌';
    reset.setAttribute('aria-label', 'Remove all points');
    reset.setAttribute('title', 'Remove all points');
    popup.appendChild(reset);

    const commit = (value) => {
      const numericValue = typeof value === 'number' ? value : Number(value);
      const points = this.normalizePoints(numericValue);
      input.value = String(points);
      update(date, points);
    };

    const stop = () => this.clearPopupTimers();
    const start = (direction) => {
      this.clearPopupTimers();
      this.popupTimers = {
        delay: setTimeout(() => {
          this.popupTimers.interval = setInterval(() => {
            commit(this.normalizePoints(trackerData[date]) + direction);
          }, 100);
        }, 400)
      };
      commit(this.normalizePoints(trackerData[date]) + direction);
    };

    const bindRapid = (btn, direction) => {
      const onMouseDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        start(direction);
      };
      const onMouseUp = (e) => { e.stopPropagation(); stop(); };
      const onTouchStart = (e) => {
        e.preventDefault();
        e.stopPropagation();
        start(direction);
      };
      const onTouchEnd = (e) => { e.stopPropagation(); stop(); };
      const onClick = (e) => { e.stopPropagation(); };

      btn.addEventListener('mousedown', onMouseDown);
      btn.addEventListener('mouseup', onMouseUp);
      btn.addEventListener('mouseleave', onMouseUp);
      btn.addEventListener('touchstart', onTouchStart, { passive: false });
      btn.addEventListener('touchend', onTouchEnd);
      btn.addEventListener('touchcancel', onTouchEnd);
      btn.addEventListener('click', onClick);

      return () => {
        btn.removeEventListener('mousedown', onMouseDown);
        btn.removeEventListener('mouseup', onMouseUp);
        btn.removeEventListener('mouseleave', onMouseUp);
        btn.removeEventListener('touchstart', onTouchStart);
        btn.removeEventListener('touchend', onTouchEnd);
        btn.removeEventListener('touchcancel', onTouchEnd);
        btn.removeEventListener('click', onClick);
      };
    };

    const cleanupMinus = bindRapid(minus, -1);
    const cleanupPlus = bindRapid(plus, 1);

    const onChange = () => commit(input.value);
    const onKeyDown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit(input.value);
        this.closePopup();
        if (cell.isConnected) cell.focus();
      }
    };
    const onResetClick = (e) => {
      e.stopPropagation();
      this.closePopup();
      update(date, 0);
      if (cell.isConnected) cell.focus();
    };

    input.addEventListener('change', onChange);
    input.addEventListener('keydown', onKeyDown);
    reset.addEventListener('click', onResetClick);

    popup.cleanupListeners = () => {
      cleanupMinus();
      cleanupPlus();
      input.removeEventListener('change', onChange);
      input.removeEventListener('keydown', onKeyDown);
      reset.removeEventListener('click', onResetClick);
    };

    this.activePopup = popup;
    
    const positionPopup = () => {
      if (!this.activePopup || this.activePopup !== popup) return;
      const rect = popup.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        requestAnimationFrame(positionPopup);
        return;
      }
      const padding = 8;
      const maxLeft = Math.max(padding, window.innerWidth - rect.width - padding);
      const maxTop = Math.max(padding, window.innerHeight - rect.height - padding);
      popup.style.left = `${Math.max(padding, Math.min(position.x, maxLeft))}px`;
      popup.style.top = `${Math.max(padding, Math.min(position.y, maxTop))}px`;
    };
    requestAnimationFrame(positionPopup);
    
    if (focusInput) {
      input.focus({ preventScroll: true });
    }
  }

  renderGrid(gridArea, trackerData, year, today, dims, stats, color, locale, contextId, key, mode) {
    const { CELL, GAP, COL } = dims;
    const todayStr = this.dateStr(today);
    const weeks = this.buildWeeks(year);
    const statsUpdate = this.renderStats(gridArea, trackerData, year, stats, color, mode);
    
    const localeData = moment.localeData(locale);
    if (!localeData || !localeData.monthsShort || !localeData.weekdaysShort) {
      console.warn(`Streak Heatmap: invalid locale "${locale}", falling back to English`);
      const fallbackLocale = moment.localeData('en');
      var months = fallbackLocale.monthsShort();
      var weekdays = fallbackLocale.weekdaysShort();
    } else {
      var months = localeData.monthsShort();
      var weekdays = localeData.weekdaysShort();
    }

    const monthRow = gridArea.createDiv({ cls: 'streak-heatmap-months' });
    monthRow.style.display = 'grid';
    monthRow.style.gridTemplateColumns = `repeat(${weeks.length}, ${COL}px)`;
    monthRow.style.marginLeft = `${COL + 4}px`;
    weeks.forEach((week) => {
      const label = monthRow.createDiv({ cls: 'streak-heatmap-month-label' });
      const firstOfMonth = week.find((date) => date.getDate() === 1 && date.getFullYear() === year);
      label.setText(firstOfMonth ? months[firstOfMonth.getMonth()] : '');
    });

    const body = gridArea.createDiv({ cls: 'streak-heatmap-body' });
    body.style.display = 'flex';

    const dayLabelsCol = body.createDiv({ cls: 'streak-heatmap-daylabels' });
    dayLabelsCol.style.display = 'grid';
    dayLabelsCol.style.gridTemplateRows = `repeat(7, ${COL}px)`;
    dayLabelsCol.style.width = `${COL}px`;
    for (let row = 0; row < 7; row += 1) {
      dayLabelsCol.createDiv({ cls: 'streak-heatmap-day-label' }).setText([1, 3, 5].includes(row) ? weekdays[row] : '');
    }

    const grid = body.createDiv({ cls: 'streak-heatmap-grid' });
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = `repeat(${weeks.length}, ${CELL}px)`;
    grid.style.gridAutoFlow = 'column';
    grid.style.gridTemplateRows = `repeat(7, ${CELL}px)`;
    grid.style.gap = `${GAP}px`;

    const cellByDate = Object.create(null);
    const simpleListenersByDate = Object.create(null);
    const detailedListenersByDate = Object.create(null);
    
    const onSimpleDateChange = (date, listener) => {
      if (!simpleListenersByDate[date]) simpleListenersByDate[date] = [];
      simpleListenersByDate[date].push(listener);
    };
    const onDetailedDateChange = (date, listener) => {
      if (!detailedListenersByDate[date]) detailedListenersByDate[date] = [];
      detailedListenersByDate[date].push(listener);
    };
    
    const finishSimpleUpdate = (date) => {
      const isMarked = !!trackerData[date];
      (simpleListenersByDate[date] || []).forEach((listener) => listener(isMarked));
      if (statsUpdate) statsUpdate();
      this.refreshContextsForKey(key, contextId);
      this.scheduleSave();
    };
    
    const finishDetailedUpdate = (date) => {
      const points = this.normalizePoints(trackerData[date]);
      (detailedListenersByDate[date] || []).forEach((listener) => listener({ marked: points > 0, points }));
      if (statsUpdate) statsUpdate();
      this.refreshContextsForKey(key, contextId);
      this.scheduleSave();
    };

    const toggleSimpleDate = (date) => {
      if (trackerData[date]) delete trackerData[date];
      else trackerData[date] = 1;
      finishSimpleUpdate(date);
    };

    const setDetailedPoints = (date, value) => {
      const points = this.normalizePoints(value);
      if (points > 0) trackerData[date] = points;
      else delete trackerData[date];
      finishDetailedUpdate(date);
    };
    
    const addDetailedPoint = (date) => {
      const current = this.normalizePoints(trackerData[date]);
      setDetailedPoints(date, Math.min(MAX_POINTS, current + 1));
    };

    let gridCleanup = null;

    if (mode === 'detailed') {
      let longPressTimer = null;
      let touchOrigin = null;
      let suppressDate = null;
      let suppressClickUntil = 0;
      
      const clearLongPress = () => {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        touchOrigin = null;
      };
      
      const eventCell = (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const cell = target ? target.closest('.streak-heatmap-cell') : null;
        return cell && grid.contains(cell) && cell.dataset.date && !cell.classList.contains('is-future') ? cell : null;
      };

      const onClick = (event) => {
        const cell = eventCell(event);
        if (!cell) return;
        if (cell.dataset.date === suppressDate && Date.now() < suppressClickUntil) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        addDetailedPoint(cell.dataset.date);
      };

      const onKeyDown = (event) => {
        const cell = eventCell(event);
        if (!cell) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          addDetailedPoint(cell.dataset.date);
        } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const rect = cell.getBoundingClientRect();
          this.showPointsPopup(
            { x: rect.left, y: rect.bottom + 4 },
            cell,
            trackerData,
            setDetailedPoints,
            document.body,
            true,
            contextId
          );
        }
      };

      const onContextMenu = (event) => {
        const cell = eventCell(event);
        if (!cell) return;
        clearLongPress();
        event.preventDefault();
        event.stopPropagation();
        this.showPointsPopup(
          { x: event.clientX, y: event.clientY },
          cell,
          trackerData,
          setDetailedPoints,
          document.body,
          false,
          contextId
        );
      };

      const onPointerDown = (event) => {
        if (event.pointerType !== 'touch') return;
        const cell = eventCell(event);
        if (!cell) return;
        clearLongPress();
        touchOrigin = { x: event.clientX, y: event.clientY };
        longPressTimer = setTimeout(() => {
          const rect = cell.getBoundingClientRect();
          suppressDate = cell.dataset.date;
          suppressClickUntil = Date.now() + 1000;
          this.showPointsPopup(
            { x: rect.left, y: rect.bottom + 4 },
            cell,
            trackerData,
            setDetailedPoints,
            document.body,
            false,
            contextId
          );
          longPressTimer = null;
        }, LONG_PRESS_MS);
      };

      const onPointerMove = (event) => {
        if (!touchOrigin) return;
        if (Math.abs(event.clientX - touchOrigin.x) > LONG_PRESS_MOVE_PX
          || Math.abs(event.clientY - touchOrigin.y) > LONG_PRESS_MOVE_PX) clearLongPress();
      };

      grid.addEventListener('click', onClick);
      grid.addEventListener('keydown', onKeyDown);
      grid.addEventListener('contextmenu', onContextMenu);
      grid.addEventListener('pointerdown', onPointerDown, { passive: true });
      grid.addEventListener('pointermove', onPointerMove, { passive: true });
      grid.addEventListener('pointerup', clearLongPress, { passive: true });
      grid.addEventListener('pointercancel', clearLongPress, { passive: true });

      gridCleanup = () => {
        clearLongPress();
        grid.removeEventListener('click', onClick);
        grid.removeEventListener('keydown', onKeyDown);
        grid.removeEventListener('contextmenu', onContextMenu);
        grid.removeEventListener('pointerdown', onPointerDown);
        grid.removeEventListener('pointermove', onPointerMove);
        grid.removeEventListener('pointerup', clearLongPress);
        grid.removeEventListener('pointercancel', clearLongPress);
      };
    }

    weeks.forEach((week) => {
      week.forEach((date) => {
        if (date.getFullYear() !== year) {
          const filler = grid.createDiv();
          filler.style.width = `${CELL}px`;
          filler.style.height = `${CELL}px`;
          return;
        }

        const dateString = this.dateStr(date);
        const rawValue = trackerData[dateString];
        const points = mode === 'detailed' ? this.normalizePoints(rawValue) : 0;
        const marked = mode === 'detailed' ? points > 0 : !!rawValue;
        const isFuture = dateString > todayStr;
        const formattedDate = this.formatDate(dateString, locale);

        const cell = grid.createDiv({ cls: 'streak-heatmap-cell' });
        cell.style.width = `${CELL}px`;
        cell.style.height = `${CELL}px`;
        cell.style.borderRadius = '3px';
        cell.classList.toggle('is-marked', marked);

        if (mode === 'detailed') {
          cell.dataset.date = dateString;
          cell.dataset.level = String(this.pointLevel(points));
          cell.style.setProperty('--cell-color', color || '#39d353');
        } else if (color && marked) {
          cell.style.backgroundColor = color;
        }

        if (isFuture) {
          cell.classList.add('is-future');
          return;
        }

        cellByDate[dateString] = cell;
        cell.setAttr('role', 'button');
        cell.setAttr('tabindex', '0');

        if (mode === 'simple') {
          cell.setAttr('aria-label', formattedDate);
          cell.setAttr('aria-pressed', String(marked));
          cell.setAttr('aria-live', 'polite');
          onSimpleDateChange(dateString, (isMarked) => {
            cell.classList.toggle('is-marked', isMarked);
            if (color) cell.style.backgroundColor = isMarked ? color : '';
            cell.setAttr('aria-pressed', String(isMarked));
          });
          cell.onclick = () => toggleSimpleDate(dateString);
          cell.onkeydown = (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              toggleSimpleDate(dateString);
            }
          };
        } else {
          const updateDetailedCell = ({ marked: isMarked, points: currentPoints }) => {
            cell.classList.toggle('is-marked', isMarked);
            cell.dataset.level = String(this.pointLevel(currentPoints));
            const labelText = `${formattedDate} — ${currentPoints} points`;
            cell.setAttr('aria-label', labelText);
          };
          updateDetailedCell({ marked, points });
          onDetailedDateChange(dateString, updateDetailedCell);
          cell.setAttr('aria-live', 'polite');
        }
      });
    });

    if (cellByDate[todayStr]) {
      const btnRow = gridArea.createDiv({ cls: 'streak-heatmap-btnrow' });
      const button = btnRow.createEl('button', { text: 'Mark today' });
      
      const updateLabel = (isMarked) => {
        button.setText(isMarked ? 'Unmark today' : 'Mark today');
        button.setAttr('aria-pressed', String(isMarked));
      };
      
      updateLabel(!!trackerData[todayStr]);

      if (mode === 'simple') {
        onSimpleDateChange(todayStr, updateLabel);
        button.onclick = () => toggleSimpleDate(todayStr);
      } else {
        onDetailedDateChange(todayStr, ({ marked }) => updateLabel(marked));
        button.onclick = () => setDetailedPoints(todayStr, this.normalizePoints(trackerData[todayStr]) > 0 ? 0 : 1);
      }
    }

    if (mode === 'detailed') {
      const legend = gridArea.createDiv({ cls: 'streak-heatmap-legend' });
      legend.createSpan({ text: 'Less' });
      for (let level = 0; level <= 4; level += 1) {
        const swatch = legend.createDiv({ cls: 'streak-heatmap-legend-cell' });
        swatch.dataset.level = String(level);
        swatch.style.setProperty('--cell-color', color || '#39d353');
        swatch.setAttr('aria-hidden', 'true');
      }
      legend.createSpan({ text: 'More' });
    }

    return gridCleanup;
  }

  renderHeatmap(source, el, ctx) {
    const params = this.parseParams(source);
    const mode = params.mode === 'detailed' ? 'detailed' : 'simple';
    const title = params.title;
    const stats = ['bar', 'text'].includes(params.stats) ? params.stats : 'none';
    const color = this.normalizeColor(params.color);

    const key = title ? title.toLowerCase().replace(/\s+/g, '-') : 'default';
    const trackerData = this.getTrackerData(key);

    const container = el.createDiv({
      cls: mode === 'detailed' ? 'streak-heatmap-container is-detailed' : 'streak-heatmap-container'
    });
    if (title) {
      container.createEl('h4', { text: title });
    }

    const currentYear = new Date().getFullYear();
    let minDataYear = currentYear;
    const dateKeys = Object.keys(trackerData);
    dateKeys.forEach((date) => {
      if (!this.isValidDateString(date)) return;
      const year = Number.parseInt(date.slice(0, 4), 10);
      if (Number.isInteger(year) && year < minDataYear) minDataYear = year;
    });
    const pastYearsToShow = Math.min(MAX_PAST_YEARS, Math.max(1, currentYear - minDataYear));

    const yearRow = container.createDiv({ cls: 'streak-heatmap-years' });
    const gridArea = container.createDiv({ cls: 'streak-heatmap-gridarea' });
    let selectedYear = currentYear;
    const buttons = [];
    const contextId = this.generateId();

    let currentGridCleanup = null;

    const draw = () => {
      if (this.activePopup && this.activePopup.contextId === contextId) {
        this.closePopup();
      }
      if (currentGridCleanup) {
        currentGridCleanup();
        currentGridCleanup = null;
      }
      gridArea.empty();
      const today = new Date();
      const locale = moment().locale();
      const dims = this.getResponsiveDims();
      currentGridCleanup = this.renderGrid(
        gridArea,
        trackerData,
        selectedYear,
        today,
        dims,
        stats,
        color,
        locale,
        contextId,
        key,
        mode
      );
      buttons.forEach(({ button, year }) => {
        const active = year === selectedYear;
        button.classList.toggle('is-active', active);
        button.setAttr('aria-pressed', String(active));
      });
    };

    const context = {
      id: contextId,
      key,
      mode,
      path: ctx ? ctx.sourcePath : undefined,
      title: (title || '').trim().toLowerCase(),
      el,
      trackerData,
      draw
    };
    this.heatmapContexts.set(contextId, context);

    if (ctx) {
      const child = new MarkdownRenderChild(el);
      child.onunload = () => {
        if (currentGridCleanup) {
          currentGridCleanup();
          currentGridCleanup = null;
        }
        this.heatmapContexts.delete(contextId);
        if (this.activePopup && this.activePopup.contextId === contextId) this.closePopup();
      };
      ctx.addChild(child);
    }

    if (mode === 'detailed' && context.path) {
      const file = this.app.vault.getAbstractFileByPath(context.path);
      this.cacheFile(file);
    }

    const makeYearButton = (year) => {
      const button = yearRow.createEl('button', {
        text: String(year),
        cls: 'streak-heatmap-year-btn',
        attr: { 'aria-label': `Show year ${year}` }
      });
      button.style.setProperty('--year-color', color || '#39d353');
      button.onclick = () => {
        selectedYear = year;
        draw();
      };
      buttons.push({ button, year });
    };

    makeYearButton(currentYear);
    for (let index = 1; index <= pastYearsToShow; index += 1) makeYearButton(currentYear - index);
    draw();
  }
};