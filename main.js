const { Plugin, MarkdownRenderChild, moment } = require('obsidian');

const MAX_PAST_YEARS = 6;
const SAVE_DEBOUNCE_MS = 300;
const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;
const MAX_POINTS = 9999;
const MAX_COLOR_CACHE_SIZE = 200;
const MAX_FILE_SIZE_KB = 100;
const MAX_INPUT_CHARS = 4;
const TASK_LOGS_KEY = '$$__taskLogs$$';
const OTHER_TASK_KEY = '__other_tasks__';
const MAX_TASK_NAME_LEN = 60;
const MAX_TASKS_PER_DAY = 30;

module.exports = class StreakHeatmapPlugin extends Plugin {
  async onload() {
    this._unloading = false;
    this.colorCache = new Map();
    this.heatmapContexts = new Map();
    this.fileStates = new Map();
    this.activePopup = null;
    this.popupTimers = null;
    this._saveTimer = null;
    this._saving = false;
    this._saveAgain = false;
    this._savePromise = Promise.resolve();
    this._dirty = false;
    this.weeksCache = new Map();
    this.fullWidthPaths = new Set();

    let needsMigration = false;

    try {
      this.data = (await this.loadData()) || {};
      needsMigration = this.normalizeData();
    } catch (e) {
      console.error('Streak Heatmap: failed to load saved data', e);
      this.data = Object.create(null);
    }

    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      this.cacheDetailedFile(file);
      this.refreshFullWidthLeaves();
    }));

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      this.refreshFullWidthLeaves();
    }));

    this.registerEvent(this.app.vault.on('modify', (file) => {
      this.processFileModify(file);
    }));

    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      const state = this.fileStates.get(oldPath);
      if (state) {
        this.fileStates.delete(oldPath);
        this.fileStates.set(file.path, state);
      }
      this.heatmapContexts.forEach((context) => {
        if (context.path === oldPath) context.path = file.path;
      });
      if (this.fullWidthPaths.has(oldPath)) {
        this.fullWidthPaths.delete(oldPath);
        this.fullWidthPaths.add(file.path);
      }
      this.refreshFullWidthLeaves();
    }));

    this.registerEvent(this.app.vault.on('delete', (file) => {
      this.fileStates.delete(file.path);
      this.fullWidthPaths.delete(file.path);
      this.refreshFullWidthLeaves();
    }));

    this.registerDomEvent(document, 'click', (event) => {
      if (this.activePopup && !this.activePopup.contains(event.target)) {
        this.closePopup();
      }
    });

    this.registerDomEvent(document, 'touchstart', (event) => {
      if (this.activePopup && !this.activePopup.contains(event.target)) {
        this.closePopup();
      }
    }, { passive: true });

    this.registerDomEvent(document, 'keydown', (event) => {
      if (event.key !== 'Escape' || !this.activePopup) return;
      const triggerCell = this.activePopup.triggerCell;
      this.closePopup();
      if (triggerCell && triggerCell.isConnected) triggerCell.focus();
    });

    this.registerMarkdownCodeBlockProcessor('streak', (source, el, ctx) => {
      this.renderHeatmap(source, el, ctx);
    });

    this.register(() => clearTimeout(this._saveTimer));

    this.register(() => {
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view?.containerEl) leaf.view.containerEl.classList.remove('streak-heatmap-full-width-view');
      });
    });

    this.app.workspace.onLayoutReady(() => this.refreshFullWidthLeaves());

    if (needsMigration) this.scheduleSave();
  }

  refreshFullWidthLeaves() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!view || view.getViewType() !== 'markdown' || !view.containerEl) return;
      const needsFullWidth = !!(view.file && this.fullWidthPaths.has(view.file.path));
      view.containerEl.classList.toggle('streak-heatmap-full-width-view', needsFullWidth);
    });
  }

  async onunload() {
    this._unloading = true;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this.weeksCache.clear();
    this.closePopup();

    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view?.containerEl) leaf.view.containerEl.classList.remove('streak-heatmap-full-width-view');
    });

    if (this._dirty || this._saving) {
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
      if (idx === -1) return;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (!key) return;

      if (key === 'title' || key === 'id' || key === 'color') {
        params[key] = value;
      } else if (key === 'stats') {
        validStats.includes(value) ? params[key] = value : console.warn(`Streak Heatmap: invalid stats "${value}"`);
      } else if (key === 'mode') {
        validModes.includes(value) ? params[key] = value : console.warn(`Streak Heatmap: invalid mode "${value}"`);
      } else if (key === 'width') {
        value === 'full' ? params[key] = value : console.warn(`Streak Heatmap: invalid width "${value}"`);
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
    if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value > MAX_POINTS) {
      console.warn(`Streak Heatmap: points exceed MAX_POINTS, clamping to max`);
      return MAX_POINTS;
    }
    return value;
  }

  normalizeTaskName(value, trackerTitle) {
    if (typeof value !== 'string') return null;
    let name = value.trim();
    if (!name) return null;
    name = this.stripDateBadge(name).trim();
    if (!name) return null;
    
    // Filtra/remove o prefixo do título do tracker (ex: "Chores:") se presente
    if (trackerTitle) {
      const prefix = trackerTitle.trim() + ':';
      if (name.toLowerCase().startsWith(prefix.toLowerCase())) {
        name = name.slice(prefix.length).trim();
      }
    }
    
    if (name.length > MAX_TASK_NAME_LEN) name = name.substring(0, MAX_TASK_NAME_LEN - 1) + '…';
    return name;
  }

  stripDateBadge(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}(?=\s|$)/g, '').trim();
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

    let taskLogs;
    if (this.data[TASK_LOGS_KEY]) {
      taskLogs = this.data[TASK_LOGS_KEY];
      delete this.data[TASK_LOGS_KEY];
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
        if (points > 0) {
          trackerData[date] = points;
        } else {
          delete trackerData[date];
        }
        if (points !== value) changed = true;
      });
    });

    if (taskLogs && typeof taskLogs === 'object' && !Array.isArray(taskLogs)) {
      if (Object.getPrototypeOf(taskLogs) !== null) {
        Object.setPrototypeOf(taskLogs, null);
        changed = true;
      }

      Object.entries(taskLogs).forEach(([trackerKey, datesObj]) => {
        if (!this.data[trackerKey] || !datesObj || typeof datesObj !== 'object' || Array.isArray(datesObj)) {
          delete taskLogs[trackerKey];
          changed = true;
          return;
        }
        if (Object.getPrototypeOf(datesObj) !== null) {
          Object.setPrototypeOf(datesObj, null);
          changed = true;
        }

        Object.entries(datesObj).forEach(([date, tasks]) => {
          if (!this.isValidDateString(date) || !tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
            delete datesObj[date];
            changed = true;
            return;
          }
          if (Object.getPrototypeOf(tasks) !== null) {
            Object.setPrototypeOf(tasks, null);
            changed = true;
          }

          Object.entries(tasks).forEach(([rawName, count]) => {
            if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
              delete tasks[rawName];
              changed = true;
              return;
            }
            const normalizedCount = Math.min(MAX_POINTS, count);
            const normalizedName = rawName === OTHER_TASK_KEY ? OTHER_TASK_KEY : this.normalizeTaskName(rawName);

            if (!normalizedName) {
              delete tasks[rawName];
              changed = true;
              return;
            }
            if (normalizedName !== rawName || normalizedCount !== count) {
              delete tasks[rawName];
              if (tasks[normalizedName] !== undefined) {
                tasks[normalizedName] = Math.min(MAX_POINTS, tasks[normalizedName] + normalizedCount);
              } else {
                tasks[normalizedName] = normalizedCount;
              }
              changed = true;
            } else if (normalizedCount !== count) {
              tasks[rawName] = normalizedCount;
              changed = true;
            }
          });

          if (Object.keys(tasks).length === 0) {
            delete datesObj[date];
            changed = true;
          }
        });

        if (Object.keys(datesObj).length === 0) {
          delete taskLogs[trackerKey];
          changed = true;
        }
      });

      if (Object.keys(taskLogs).length > 0) this.data[TASK_LOGS_KEY] = taskLogs;
    } else if (taskLogs !== undefined) {
      changed = true;
    }
    return changed;
  }

  getTrackerData(key) {
    if (!Object.prototype.hasOwnProperty.call(this.data, key) || !this.data[key] || typeof this.data[key] !== 'object' || Array.isArray(this.data[key])) {
      this.data[key] = Object.create(null);
    }
    return this.data[key];
  }

  incrementTaskLog(dayLogs, name) {
    const normalizedName = this.normalizeTaskName(name);
    if (!normalizedName) return null;
    if (dayLogs[normalizedName] !== undefined && normalizedName !== OTHER_TASK_KEY) {
      dayLogs[normalizedName] += 1;
      return normalizedName;
    }
    const taskKeys = Object.keys(dayLogs).filter((key) => key !== OTHER_TASK_KEY);
    if (taskKeys.length >= MAX_TASKS_PER_DAY) {
      dayLogs[OTHER_TASK_KEY] = (dayLogs[OTHER_TASK_KEY] || 0) + 1;
      console.warn(`Streak Heatmap: reached the ${MAX_TASKS_PER_DAY}-task/day limit — "${normalizedName}" was grouped into "Other tasks"`);
      return OTHER_TASK_KEY;
    }
    dayLogs[normalizedName] = (dayLogs[normalizedName] || 0) + 1;
    return normalizedName;
  }

  ensureDayLogs(trackerKey, date) {
    if (!this.data[TASK_LOGS_KEY]) this.data[TASK_LOGS_KEY] = Object.create(null);
    if (!this.data[TASK_LOGS_KEY][trackerKey]) this.data[TASK_LOGS_KEY][trackerKey] = Object.create(null);
    if (!this.data[TASK_LOGS_KEY][trackerKey][date]) this.data[TASK_LOGS_KEY][trackerKey][date] = Object.create(null);
    return this.data[TASK_LOGS_KEY][trackerKey][date];
  }

  cleanupTaskLogs(trackerKey, date) {
    const allLogs = this.data[TASK_LOGS_KEY];
    if (!allLogs?.[trackerKey]) return;
    if (date && allLogs[trackerKey][date] && Object.keys(allLogs[trackerKey][date]).length === 0) {
      delete allLogs[trackerKey][date];
    }
    if (Object.keys(allLogs[trackerKey]).length === 0) delete allLogs[trackerKey];
    if (Object.keys(allLogs).length === 0) delete this.data[TASK_LOGS_KEY];
  }

  logTask(trackerKey, date, rawName) {
    const name = this.normalizeTaskName(rawName);
    if (!name) return;
    this.incrementTaskLog(this.ensureDayLogs(trackerKey, date), name);
  }

  normalizeColor(value) {
    const cacheKey = value || '';
    if (this.colorCache.has(cacheKey)) {
      const cachedValue = this.colorCache.get(cacheKey);
      this.colorCache.delete(cacheKey);
      this.colorCache.set(cacheKey, cachedValue);
      return cachedValue;
    }

    if (this.colorCache.size >= MAX_COLOR_CACHE_SIZE) {
      const firstKey = this.colorCache.keys().next().value;
      this.colorCache.delete(firstKey);
    }

    const cache = (result) => {
      this.colorCache.set(cacheKey, result);
      return result;
    };

    if (!value) return cache(null);
    let trimmed = value.trim();

    const rgbNumbersMatch = trimmed.match(/^\s*\(?\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)?\s*$/);
    if (rgbNumbersMatch) trimmed = `rgb(${rgbNumbersMatch[1]}, ${rgbNumbersMatch[2]}, ${rgbNumbersMatch[3]})`;

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
      this.register(() => this._colorProbe?.remove());
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
    this._dirty = true;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  async flushSave() {
    if (this._unloading && !this._saving) return;
    if (this._saving) {
      this._saveAgain = true;
      return this._savePromise;
    }
    this._saving = true;

    this._savePromise = (async () => {
      let success = true;
      try {
        do {
          this._saveAgain = false;
          const saved = await this._saveDataWithRetry();
          if (!saved) {
            success = false;
            break;
          }
        } while (this._saveAgain);
      } catch (e) {
        success = false;
        console.error('Streak Heatmap: failed to save data', e);
      } finally {
        this._saving = false;
        if (success) this._dirty = false;
      }
    })();
    return this._savePromise;
  }

  async _saveDataWithRetry() {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.normalizeData();
        await this.saveData(this.data);
        return true;
      } catch (e) {
        console.error(`Streak Heatmap: save attempt ${attempt} failed`, e);
        if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    console.error('Streak Heatmap: all save attempts failed, data not persisted');
    return false;
  }

  closePopup() {
    if (!this.activePopup) return;
    const popup = this.activePopup;
    if (popup.commitOnClose && !popup._skipCommit && !popup.isEditingTasks) popup.commitOnClose();
    if (popup.cleanupListeners) popup.cleanupListeners();
    popup.remove();
    this.activePopup = null;
    this.clearPopupTimers();
  }

  clearPopupTimers() {
    if (!this.popupTimers) return;
    clearTimeout(this.popupTimers.delay);
    clearInterval(this.popupTimers.interval);
    this.popupTimers = null;
  }

  refreshContextsForKey(key, excludeId, date) {
    this.heatmapContexts.forEach((context) => {
      if (context.key === key && context.id !== excludeId) {
        if (date && context.updateDate) {
          context.updateDate(date);
        } else if (context.draw) {
          context.draw();
        }
        if (context.updateStats) context.updateStats();
      }
    });
  }

  hasDetailedContextForPath(path) {
    return [...this.heatmapContexts.values()].some((c) => c.mode === 'detailed' && c.path === path);
  }

  async cacheDetailedFile(file) {
    if (!file || file.extension !== 'md' || !this.hasDetailedContextForPath(file.path)) return;
    await this.cacheFile(file);
  }

  async cacheFile(file) {
    if (this._unloading || !file || file.extension !== 'md') return;
    const state = this.fileStates.get(file.path) || { state: 'idle', snapshot: null, readVersion: 0 };
    state.readVersion = (state.readVersion || 0) + 1;
    const version = state.readVersion;
    this.fileStates.set(file.path, state);

    const text = await this.readFileSnapshot(file);
    if (text === null) return;
    const currentState = this.fileStates.get(file.path);
    if (!currentState || currentState.readVersion !== version) return;

    if (text.length / 1024 > MAX_FILE_SIZE_KB) {
      currentState.snapshot = null;
      return;
    }
    currentState.snapshot = text;
  }

  async readFileSnapshot(file) {
    if (!file || file.extension !== 'md') return null;
    try {
      return await this.app.vault.read(file);
    } catch (e) {
      console.error('Streak Heatmap: failed to read file snapshot', file.path, e);
      return null;
    }
  }

  escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  taskContent(line, checked) {
    if (!line || typeof line !== 'string') return null;
    const state = checked ? '[xX]' : ' ';
    const match = line.match(new RegExp(`^\\s*[-*+]\\s+\\[${state}\\]\\s+(.+)$`));
    return match ? match[1].trim() : null;
  }

  _getDetailedContextsForPath(path) {
    const seenKeys = new Set();
    return [...this.heatmapContexts.values()].filter((context) => {
      if (!context || context.mode !== 'detailed' || context.path !== path || !context.title) return false;
      if (seenKeys.has(context.key)) return false;
      seenKeys.add(context.key);
      return true;
    });
  }

  async processFileModify(file) {
    if (this._unloading || !file || file.extension !== 'md' || !file.path) return;
    let state = this.fileStates.get(file.path);

    if (!state) {
      state = { state: 'idle', snapshot: null, readVersion: 0 };
      this.fileStates.set(file.path, state);
    }

    if (state.state === 'processing') {
      state.state = 'queued';
      return;
    }

    state.state = 'processing';
    try {
      await this._processFileOnce(file, state);
    } finally {
      if (state.state === 'queued') {
        state.state = 'idle';
        await this.processFileModify(file);
      } else {
        state.state = 'idle';
      }
    }
  }

  async _processFileOnce(file, state) {
    const contexts = this._getDetailedContextsForPath(file.path);
    if (!contexts.length) {
      const currentText = await this.readFileSnapshot(file);
      if (currentText !== null) state.snapshot = currentText;
      return;
    }

    const currentText = await this.readFileSnapshot(file);
    if (currentText === null) return;
    const previousSnapshot = state.snapshot;
    if (previousSnapshot === null) {
      state.snapshot = currentText;
      return;
    }
    if (currentText.length / 1024 > MAX_FILE_SIZE_KB) {
      state.snapshot = null;
      return;
    }

    const prevUnchecked = new Map();
    previousSnapshot.split(/\r?\n/).forEach((line) => {
      const content = this.taskContent(line, false);
      if (content) {
        const normalized = this.normalizeTaskName(content);
        if (normalized) prevUnchecked.set(normalized, (prevUnchecked.get(normalized) || 0) + 1);
      }
    });

    const today = this.dateStr(new Date());
    if (!this.isValidDateString(today)) {
      state.snapshot = currentText;
      return;
    }

    const badgeRegex = new RegExp(`✅\\s*${this.escapeRegExp(today)}(?=\\s|$)`);
    const anyBadgeRegex = /\s*✅\s*\d{4}-\d{2}-\d{2}(?=\s|$)/;
    const pointsByKey = new Map();
    const namesByKey = new Map();
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
            const cleanTitle = this.normalizeTaskName(rawTitle);
            if (!cleanTitle) return line;

            const remaining = prevUnchecked.get(cleanTitle) || 0;
            if (remaining <= 0) return line;
            prevUnchecked.set(cleanTitle, remaining - 1);

            const matches = compiledContexts.filter((ctx) => ctx.regex.test(cleanTitle));
            if (!matches.length) return line;

            const matchedKeys = new Set(matches.map((ctx) => ctx.key));
            matchedKeys.forEach((key) => {
              pointsByKey.set(key, (pointsByKey.get(key) || 0) + 1);
            });

            matches.forEach((ctx) => {
              if (!namesByKey.has(ctx.key)) namesByKey.set(ctx.key, []);
              namesByKey.get(ctx.key).push(cleanTitle);
            });

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

      const finalText = await this.readFileSnapshot(file);
      if (finalText !== null) state.snapshot = finalText;

      if (pointsByKey.size) {
        pointsByKey.forEach((points, key) => {
          const trackerData = this.getTrackerData(key);
          trackerData[today] = Math.min(MAX_POINTS, this.normalizePoints(trackerData[today]) + points);
        });

        namesByKey.forEach((names, key) => {
          names.forEach((name) => this.logTask(key, today, name));
        });

        pointsByKey.forEach((_, key) => this.refreshContextsForKey(key, null, today));
        this.scheduleSave();
      }
    } catch (e) {
      console.error('Streak Heatmap: failed to process file', file.path, e);
      const fallbackText = await this.readFileSnapshot(file);
      if (fallbackText !== null) state.snapshot = fallbackText;
    }
  }

  buildWeeks(year, locale = 'en') {
    const localeData = moment.localeData(locale);
    const firstDay = localeData ? localeData.firstDayOfWeek() : 0;
    const cacheKey = `weeks-${year}-${firstDay}`;

    if (this.weeksCache.has(cacheKey)) return this.weeksCache.get(cacheKey);

    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);
    const gridStart = new Date(start);
    const dayOfWeek = (start.getDay() - firstDay + 7) % 7;
    gridStart.setDate(gridStart.getDate() - dayOfWeek);

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
    this.weeksCache.set(cacheKey, weeks);
    return weeks;
  }

  getStats(trackerData, year) {
    const daysInYear = new Date(year, 1, 29).getDate() === 29 ? 366 : 365;
    let total = 0, points = 0, maxStreak = 0, currentStreak = 0;
    const cursor = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);

    while (cursor <= end) {
      const dayPoints = this.normalizePoints(trackerData[this.dateStr(cursor)]);
      if (dayPoints > 0) {
        total++;
        points += dayPoints;
        currentStreak++;
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

  dateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  isValidDateString(dateStr) {
    if (!dateStr || typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
    const [year, month, day] = dateStr.split('-').map(Number);
    if (year < 1970 || year > 3000 || month < 1 || month > 12 || day < 1 || day > 31) return false;
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date <= today;
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

  getKnownTasksForDate(trackerKey, date, context) {
    const knownTasks = [];
    const seen = new Set();

    if (context && context.path && context.title) {
      const state = this.fileStates.get(context.path);
      const snapshot = state?.snapshot;

      if (snapshot) {
        const titleLower = context.title.toLowerCase();
        snapshot.split(/\r?\n/).forEach((line) => {
          const rawTitle = this.taskContent(line, true) || this.taskContent(line, false);
          if (!rawTitle) return;
          
          const cleanTitle = this.normalizeTaskName(rawTitle);
          if (!cleanTitle) return;
          
          if (cleanTitle.toLowerCase().includes(titleLower) && !seen.has(cleanTitle)) {
            seen.add(cleanTitle);
            knownTasks.push(cleanTitle);
          }
        });
      }
    }

    const trackerLogs = this.data[TASK_LOGS_KEY]?.[trackerKey];
    const dayLogs = trackerLogs?.[date];

    if (dayLogs && typeof dayLogs === 'object') {
      Object.keys(dayLogs).forEach((name) => {
        if (name !== OTHER_TASK_KEY) {
          const normalized = this.normalizeTaskName(name);
          if (normalized && !seen.has(normalized)) {
            seen.add(normalized);
            knownTasks.push(normalized);
          }
        }
      });
    }

    return knownTasks;
  }

  showPointsPopup(position, cell, trackerData, update, popupHost, focusInput, contextId, key) {
    this.closePopup();
    const date = cell.dataset.date;
    const popup = document.createElement('div');
    popup.className = 'streak-heatmap-popup';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-modal', 'true');

    const titleId = `popup-title-${contextId}`;
    const titleEl = document.createElement('div');
    titleEl.id = titleId;
    titleEl.style.display = 'none';
    titleEl.textContent = `Edit points for ${date}`;
    popup.appendChild(titleEl);
    popup.setAttribute('aria-labelledby', titleId);
    popup.triggerCell = cell;
    popup.contextId = contextId;
    popup.isEditingTasks = false;
    popup._skipCommit = false;

    const stopPropagation = (e) => e.stopPropagation();
    popup.addEventListener('click', stopPropagation);
    popup.addEventListener('touchstart', stopPropagation, { passive: true });
    popupHost.appendChild(popup);

    const controlsRow = document.createElement('div');
    controlsRow.style.display = 'flex';
    controlsRow.style.flexDirection = 'row';
    controlsRow.style.alignItems = 'center';
    controlsRow.style.justifyContent = 'center';
    controlsRow.style.gap = '6px';
    controlsRow.style.flex = '0 0 auto';
    popup.appendChild(controlsRow);

    const minus = document.createElement('button');
    minus.type = 'button';
    minus.textContent = '−';
    minus.setAttribute('aria-label', 'Remove one point');
    controlsRow.appendChild(minus);

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
    controlsRow.appendChild(input);

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = '+';
    plus.setAttribute('aria-label', 'Add one point');
    controlsRow.appendChild(plus);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = '❌';
    reset.setAttribute('aria-label', 'Remove all points');
    controlsRow.appendChild(reset);

    const listContainer = document.createElement('div');
    listContainer.className = 'streak-heatmap-task-list';
    popup.appendChild(listContainer);

    const context = this.heatmapContexts.get(contextId);
    const getCurrentDayLogs = () => {
      return this.data[TASK_LOGS_KEY]?.[key]?.[date] || {};
    };
    const originalDayLogs = structuredClone(getCurrentDayLogs());
    let draftDayLogs = structuredClone(originalDayLogs);
    let draftPoints = this.normalizePoints(trackerData[date]);
    const knownTasks = this.getKnownTasksForDate(key, date, context);
    let isEditMode = false;
    popup.isEditingTasks = false;

    const calculateLoggedSum = (logs) => {
      return Object.keys(logs || {}).reduce((sum, taskName) => {
        return sum + this.normalizePoints(logs[taskName]);
      }, 0);
    };

    const applyDraft = () => {
      const currentLogs = this.ensureDayLogs(key, date);
      Object.keys(currentLogs).forEach((taskName) => delete currentLogs[taskName]);
      Object.entries(draftDayLogs).forEach(([taskName, count]) => {
        if (taskName === OTHER_TASK_KEY) {
          if (Number.isInteger(count) && count > 0) currentLogs[OTHER_TASK_KEY] = Math.min(MAX_POINTS, count);
          return;
        }
        const normalized = this.normalizeTaskName(taskName);
        if (normalized && Number.isInteger(count) && count > 0) currentLogs[normalized] = Math.min(MAX_POINTS, count);
      });
      this.cleanupTaskLogs(key, date);
      const points = this.normalizePoints(draftPoints);
      if (points > 0) trackerData[date] = points;
      else delete trackerData[date];
      update(date, points);
      this.scheduleSave();
    };

    const renderTaskList = (currentPointsStr) => {
      const currentPoints = Number(currentPointsStr) || 0;
      listContainer.empty();
      const visibleLogs = isEditMode ? draftDayLogs : getCurrentDayLogs();
      listContainer.style.display = 'block';

      const header = listContainer.createDiv({ cls: 'streak-heatmap-task-header' });
      header.createSpan({ text: 'Task log', cls: 'streak-heatmap-task-header-title' });

      const editBtn = header.createEl('button', {
        cls: 'streak-heatmap-edit-btn',
        text: isEditMode ? '✅ Done' : '✏️ Edit'
      });
      editBtn.setAttribute('aria-label', isEditMode ? 'Confirm task changes' : 'Edit task log');

      editBtn.onclick = (e) => {
        e.stopPropagation();
        if (isEditMode) {
          applyDraft();
          isEditMode = false;
          popup.isEditingTasks = false;
          renderTaskList(draftPoints);
          return;
        }
        draftDayLogs = structuredClone(getCurrentDayLogs());
        draftPoints = this.normalizePoints(trackerData[date]);
        isEditMode = true;
        popup.isEditingTasks = true;
        renderTaskList(draftPoints);
      };

      const loggedSum = calculateLoggedSum(visibleLogs);
      if (currentPoints < loggedSum) {
        listContainer.createDiv({ cls: 'streak-heatmap-task-warning' }).setText('Total adjusted manually — task history preserved');
      }

      const logKeys = Object.keys(visibleLogs).filter((k) => k !== OTHER_TASK_KEY);
      let displayKeys;
      if (isEditMode) {
        const combined = [...knownTasks];
        logKeys.forEach((k) => {
          if (!combined.includes(k)) combined.push(k);
        });
        displayKeys = combined;
      } else {
        const combined = knownTasks.filter((k) => visibleLogs[k] !== undefined);
        logKeys.forEach((k) => {
          if (!combined.includes(k)) combined.push(k);
        });
        displayKeys = combined;
      }
      if (visibleLogs[OTHER_TASK_KEY] !== undefined && (isEditMode || visibleLogs[OTHER_TASK_KEY] > 0)) {
        displayKeys.push(OTHER_TASK_KEY);
      }

      if (displayKeys.length === 0) {
        listContainer.createDiv({ cls: 'streak-heatmap-task-empty', text: 'No tasks logged' });
      } else {
        displayKeys.forEach((taskName) => {
          const count = this.normalizePoints(visibleLogs[taskName]);
          const item = listContainer.createDiv({ cls: 'streak-heatmap-task-item' });
          const displayName = taskName === OTHER_TASK_KEY ? 'Other tasks' : (this.normalizeTaskName(taskName, context?.title) || taskName);
          if (taskName === OTHER_TASK_KEY) {
            item.setAttribute('title', `Tasks beyond the ${MAX_TASKS_PER_DAY}-per-day limit are grouped here`);
          }
          const nameGroup = item.createDiv({ cls: 'streak-heatmap-task-name-group' });
          nameGroup.createSpan({ text: displayName });

          if (count > 0) {
            nameGroup.createSpan({ text: `x${count}`, cls: 'streak-heatmap-task-count' });
          } else if (isEditMode) {
            item.style.opacity = '0.6';
          }

          if (isEditMode) {
            const actions = item.createDiv({ cls: 'streak-heatmap-task-actions' });
            if (count > 0) {
              const minusBtn = actions.createEl('button', { cls: 'streak-heatmap-task-btn', text: '−' });
              minusBtn.setAttribute('aria-label', `Remove one ${displayName}`);
              minusBtn.onclick = (e) => {
                e.stopPropagation();
                if (count > 1) draftDayLogs[taskName] = count - 1;
                else delete draftDayLogs[taskName];
                draftPoints = Math.max(0, this.normalizePoints(draftPoints) - 1);
                input.value = String(draftPoints);
                renderTaskList(draftPoints);
              };
            }
            const plusBtn = actions.createEl('button', { cls: 'streak-heatmap-task-btn', text: '+' });
            plusBtn.setAttribute('aria-label', `Add one ${displayName}`);
            plusBtn.onclick = (e) => {
              e.stopPropagation();
              if (taskName === OTHER_TASK_KEY) {
                draftDayLogs[OTHER_TASK_KEY] = (draftDayLogs[OTHER_TASK_KEY] || 0) + 1;
              } else {
                const normalized = this.normalizeTaskName(taskName);
                if (!normalized) return;
      
                this.incrementTaskLog(draftDayLogs, taskName);
              }
              draftPoints = Math.min(MAX_POINTS, this.normalizePoints(draftPoints) + 1);
              input.value = String(draftPoints);
              renderTaskList(draftPoints);
            };
          }
        });
      }

      if (currentPoints > loggedSum) {
        const delta = currentPoints - loggedSum;
        const item = listContainer.createDiv({ cls: 'streak-heatmap-task-item is-manual' });
        item.createSpan({ text: 'Manual points' });
        if (delta > 0) item.createSpan({ text: `x${delta}`, cls: 'streak-heatmap-task-count' });
      }
    };

    renderTaskList(draftPoints);

    input.addEventListener('input', (e) => {
      let numVal = e.target.value;
      if (e.target.type === 'text') {
        numVal = numVal.replace(/[^\d]/g, '');
        e.target.value = numVal;
      }
      const val = Math.min(MAX_POINTS, Math.max(0, Number(numVal) || 0));
      if (Number(e.target.value) !== val && e.target.type === 'number') e.target.value = String(val);
      draftPoints = val;
      renderTaskList(val);
    });

    const commit = (value) => {
      const numericValue = typeof value === 'number' ? value : Number(value);
      const points = this.normalizePoints(numericValue);
      input.value = String(points);
      draftPoints = points;
      renderTaskList(points);
      if (!isEditMode) {
        update(date, points);
      }
    };

    popup.commitOnClose = () => {
      if (isEditMode) return;
      commit(input.value);
    };

    const stop = () => this.clearPopupTimers();
    const start = (direction) => {
      this.clearPopupTimers();
      const base = () => (isEditMode ? draftPoints : this.normalizePoints(trackerData[date]));
      this.popupTimers = {
        delay: setTimeout(() => {
          this.popupTimers.interval = setInterval(() => {
            commit(base() + direction);
          }, 100);
        }, 400)
      };
      commit(base() + direction);
    };

    const bindRapid = (btn, direction) => {
      const onMouseDown = (e) => { if (e.button === 0) { e.preventDefault(); e.stopPropagation(); start(direction); } };
      const onMouseUp = (e) => { e.stopPropagation(); stop(); };
      const onTouchStart = (e) => { e.preventDefault(); e.stopPropagation(); start(direction); };
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
        if (isEditMode) {
          applyDraft();
          isEditMode = false;
          popup.isEditingTasks = false;
          renderTaskList(draftPoints);
          return;
        }
        commit(input.value);
        this.closePopup();
        if (cell.isConnected) cell.focus();
      }
    };

    const onResetClick = (e) => {
      e.stopPropagation();
      popup._skipCommit = true;
      if (this.data[TASK_LOGS_KEY]?.[key]) {
        delete this.data[TASK_LOGS_KEY][key][date];
        this.cleanupTaskLogs(key, date);
      }
      delete trackerData[date];
      this.scheduleSave();
      update(date, 0);
      draftDayLogs = Object.create(null);
      draftPoints = 0;
      isEditMode = false;
      popup.isEditingTasks = false;
      input.value = '0';
      renderTaskList(0);
      if (cell.isConnected) cell.focus();
    };

    input.addEventListener('change', onChange);
    input.addEventListener('keydown', onKeyDown);
    reset.addEventListener('click', onResetClick);

    let attempts = 0;
    const positionPopup = () => {
      if (++attempts > 10 || !this.activePopup || this.activePopup !== popup) return;
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

    const repositionOrClose = (event) => {
      if (!this.activePopup) return;
      if (event && event.target && this.activePopup.contains(event.target)) return;
      this.closePopup();
    };

    window.addEventListener('resize', repositionOrClose, { passive: true });
    window.addEventListener('scroll', repositionOrClose, { passive: true, capture: true });

    popup.cleanupListeners = () => {
      cleanupMinus();
      cleanupPlus();
      input.removeEventListener('change', onChange);
      input.removeEventListener('keydown', onKeyDown);
      reset.removeEventListener('click', onResetClick);
      window.removeEventListener('resize', repositionOrClose);
      window.removeEventListener('scroll', repositionOrClose, { capture: true });
    };

    this.activePopup = popup;
    requestAnimationFrame(positionPopup);
    // REMovido o input.focus() automático daqui para evitar seleção indesejada na abertura
  }

  renderGrid(gridArea, trackerData, year, today, dims, stats, color, locale, contextId, key, mode) {
    const { CELL, GAP, COL } = dims;
    const todayStr = this.dateStr(today);
    const weeks = this.buildWeeks(year, locale);
    const statsUpdate = this.renderStats(gridArea, trackerData, year, stats, color, mode);
    let months, weekdays;
    let localeData = moment.localeData(locale);
    if (!localeData || !localeData.monthsShort || !localeData.weekdaysShort) {
      console.warn(`Streak Heatmap: invalid locale "${locale}", falling back to English`);
      localeData = moment.localeData('en');
    }
    months = localeData.monthsShort();
    weekdays = localeData.weekdaysShort();

    const monthRow = gridArea.createDiv({ cls: 'streak-heatmap-months' });
    monthRow.style.display = 'grid';
    monthRow.style.gridTemplateColumns = `repeat(${weeks.length}, ${COL}px)`;
    monthRow.style.marginInlineStart = `${COL}px`;

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

    const firstDayOfWeek = localeData.firstDayOfWeek();
    for (let row = 0; row < 7; row++) {
      const actualDayIndex = (row + firstDayOfWeek) % 7;
      dayLabelsCol.createDiv({ cls: 'streak-heatmap-day-label' }).setText([1, 3, 5].includes(actualDayIndex) ? weekdays[actualDayIndex] : '');
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

    const performUpdateDate = (date) => {
      const isMarked = !!trackerData[date];
      (simpleListenersByDate[date] || []).forEach((listener) => listener(isMarked));
      const points = mode === 'detailed' ? this.normalizePoints(trackerData[date]) : 0;
      (detailedListenersByDate[date] || []).forEach((listener) => listener({ marked: points > 0, points }));
    };

    const finishSimpleUpdate = (date) => {
      performUpdateDate(date);
      if (statsUpdate) statsUpdate();
      this.refreshContextsForKey(key, contextId, date);
      this.scheduleSave();
    };

    const finishDetailedUpdate = (date) => {
      performUpdateDate(date);
      if (statsUpdate) statsUpdate();
      this.refreshContextsForKey(key, contextId, date);
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
      let activePointerId = null;
      let startX = 0, startY = 0;
      let suppressDate = null;
      let suppressClickUntil = 0;

      const clearLongPress = (cell, pointerId) => {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        if (cell && pointerId !== undefined && cell.hasPointerCapture(pointerId)) cell.releasePointerCapture(pointerId);
        activePointerId = null;
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
            cell, trackerData, setDetailedPoints, document.body, true, contextId, key
          );
        }
      };

      const onContextMenu = (event) => {
        const cell = eventCell(event);
        if (!cell) return;
        clearLongPress(cell, activePointerId);
        event.preventDefault();
        event.stopPropagation();
        this.showPointsPopup(
          { x: event.clientX, y: event.clientY },
          cell, trackerData, setDetailedPoints, document.body, false, contextId, key
        );
      };

      const onPointerDown = (event) => {
        const cell = eventCell(event);
        if (!cell) return;
        activePointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        cell.setPointerCapture(activePointerId);
        if (event.pointerType !== 'touch') return;
        longPressTimer = setTimeout(() => {
          const rect = cell.getBoundingClientRect();
          suppressDate = cell.dataset.date;
          suppressClickUntil = Date.now() + 1000;
          this.showPointsPopup(
            { x: rect.left, y: rect.bottom + 4 },
            cell, trackerData, setDetailedPoints, document.body, false, contextId, key
          );
          clearLongPress(cell, activePointerId);
        }, LONG_PRESS_MS);
      };

      const onPointerMove = (event) => {
        if (activePointerId === null || event.pointerId !== activePointerId) return;
        const deltaX = Math.abs(event.clientX - startX);
        const deltaY = Math.abs(event.clientY - startY);
        if (deltaX > LONG_PRESS_MOVE_PX || deltaY > LONG_PRESS_MOVE_PX) {
          clearLongPress(eventCell(event), activePointerId);
        }
      };

      const onPointerUp = (event) => {
        clearLongPress(eventCell(event), event.pointerId);
      };

      grid.addEventListener('click', onClick);
      grid.addEventListener('keydown', onKeyDown);
      grid.addEventListener('contextmenu', onContextMenu);
      grid.addEventListener('pointerdown', onPointerDown, { passive: true });
      grid.addEventListener('pointermove', onPointerMove, { passive: true });
      grid.addEventListener('pointerup', onPointerUp, { passive: true });
      grid.addEventListener('pointercancel', onPointerUp, { passive: true });

      gridCleanup = () => {
        clearTimeout(longPressTimer);
        grid.removeEventListener('click', onClick);
        grid.removeEventListener('keydown', onKeyDown);
        grid.removeEventListener('contextmenu', onContextMenu);
        grid.removeEventListener('pointerdown', onPointerDown);
        grid.removeEventListener('pointermove', onPointerMove);
        grid.removeEventListener('pointerup', onPointerUp);
        grid.removeEventListener('pointercancel', onPointerUp);
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
          cell.style.setProperty('--cell-color', color || 'var(--streak-default-color)');
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
            cell.setAttr('aria-label', `${formattedDate} — ${currentPoints} points`);
          };

          updateDetailedCell({ marked, points });
          onDetailedDateChange(dateString, updateDetailedCell);
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
      for (let level = 0; level <= 4; level++) {
        const swatch = legend.createDiv({ cls: 'streak-heatmap-legend-cell' });
        swatch.dataset.level = String(level);
        swatch.style.setProperty('--cell-color', color || 'var(--streak-default-color)');
        swatch.setAttr('aria-hidden', 'true');
      }
      legend.createSpan({ text: 'More' });
    }

    return { cleanup: gridCleanup, updateDate: performUpdateDate, updateStats: statsUpdate };
  }

  renderHeatmap(source, el, ctx) {
    const params = this.parseParams(source);
    const mode = params.mode === 'detailed' ? 'detailed' : 'simple';
    const title = params.title;
    const stats = ['bar', 'text'].includes(params.stats) ? params.stats : 'none';
    const color = this.normalizeColor(params.color);
    const isFullWidth = params.width === 'full';
    const widthClass = isFullWidth ? 'is-full-width' : '';

    const trackerId = params.id ? params.id.trim().toLowerCase().replace(/\s+/g, '-') : null;
    const key = trackerId || (title ? title.trim().toLowerCase().replace(/\s+/g, '-') : 'default');
    const trackerData = this.getTrackerData(key);

    const container = el.createDiv({
      cls: mode === 'detailed' ? `streak-heatmap-container is-detailed ${widthClass}` : `streak-heatmap-container ${widthClass}`
    });

    if (title) container.createEl('h4', { text: title });

    const currentYear = new Date().getFullYear();
    let minDataYear = currentYear;

    Object.keys(trackerData).forEach((date) => {
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

    const context = {
      id: contextId,
      key,
      mode,
      path: ctx ? ctx.sourcePath : undefined,
      title: (title || '').trim().toLowerCase(),
      fullWidth: isFullWidth,
      el,
      trackerData,
      draw: null,
      updateDate: null,
      updateStats: null
    };

    const draw = () => {
      if (this.activePopup && this.activePopup.contextId === contextId) this.closePopup();
      if (currentGridCleanup) {
        currentGridCleanup();
        currentGridCleanup = null;
      }
      gridArea.empty();

      const today = new Date();
      const locale = moment().locale();
      const dims = this.getResponsiveDims();
      const { cleanup, updateDate, updateStats } = this.renderGrid(
        gridArea, trackerData, selectedYear, today, dims, stats, color, locale, contextId, key, mode
      );

      currentGridCleanup = cleanup;
      context.updateDate = updateDate;
      context.updateStats = updateStats;

      buttons.forEach(({ button, year }) => {
        const active = year === selectedYear;
        button.classList.toggle('is-active', active);
        button.setAttr('aria-pressed', String(active));
      });
    };

    context.draw = draw;
    this.heatmapContexts.set(contextId, context);
    let lastWidth = el.clientWidth;
    let resizeTimer = null;

    const resizeObserver = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (context.draw && el.isConnected) context.draw();
        }, 150);
      }
    });
    resizeObserver.observe(el);

    if (isFullWidth && context.path) {
      this.fullWidthPaths.add(context.path);
      this.refreshFullWidthLeaves();
    }

    if (ctx) {
      const child = new MarkdownRenderChild(el);
      child.onunload = () => {
        resizeObserver.disconnect();
        clearTimeout(resizeTimer);
        if (currentGridCleanup) {
          currentGridCleanup();
          currentGridCleanup = null;
        }
        this.heatmapContexts.delete(contextId);

        if (context.fullWidth && context.path) {
          const stillNeeded = [...this.heatmapContexts.values()].some((c) => c.path === context.path && c.fullWidth);
          if (!stillNeeded) {
            this.fullWidthPaths.delete(context.path);
            this.refreshFullWidthLeaves();
          }
        }
        if (this.activePopup && this.activePopup.contextId === contextId) this.closePopup();
      };
      ctx.addChild(child);
    }

    if (mode === 'detailed' && context.path) {
      const file = this.app.vault.getAbstractFileByPath(context.path);
      if (file) this.cacheFile(file);
    }

    const makeYearButton = (year) => {
      const button = yearRow.createEl('button', {
        text: String(year),
        cls: 'streak-heatmap-year-btn',
        attr: { 'aria-label': `Show year ${year}` }
      });
      button.style.setProperty('--year-color', color || 'var(--streak-default-color)');
      button.onclick = () => {
        selectedYear = year;
        draw();
      };
      buttons.push({ button, year });
    };

    makeYearButton(currentYear);
    for (let i = 1; i <= pastYearsToShow; i++) makeYearButton(currentYear - i);
    draw();
  }
};