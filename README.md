# Streak Heatmap

A local [Obsidian](https://obsidian.md) plugin that displays a clickable, GitHub-style contribution heatmap directly in your notes. It is perfect for tracking habits, daily routines, or writing streaks without needing any external trackers.

![Streak Heatmap](screenshot.png)
![Streak Heatmap 2](screenshot-2.png)

## ✨ Features

- **Click to Track:** Mark any past or present day with a simple click.
- **"Mark today" Button:** Quickly log today's progress without hunting for the right cell on the grid.
- **Independent Boards:** Create as many trackers as you want. Each board keeps its own isolated history.
- **Smart Calendar:** Shows a full January–December grid. Future days are faded out and unclickable. Automatically adds past years to the navigation as you log older data.
- **Accessible & Mobile Friendly:** Fully supports keyboard navigation (`Tab`, `Enter`, `Space`) and touch interactions for mobile devices.

## 🚀 Usage

To create a tracker, insert a `streak` code block into any note:

    ```streak
    ```

To name a board and keep its data separate from other boards in your vault, use the `title` parameter:

    ```streak
    title: Reading Habit
    ```

---

## ⚙️ Display Modes

The plugin operates in two distinct modes depending on how you want to track your data.

### 1. Simple Mode (Default)
If you don't specify a mode, the board defaults to `simple`. This is ideal for basic "done/not done" habit tracking.
- **Interaction:** Click an empty day to mark it (it turns colored). Click it again to unmark it.

    ```streak
    title: Drink Water
    mode: simple
    ```

### 2. Detailed Mode
Detailed mode is for tracking specific numerical values (like pages read, miles run, or hours studied). The cell's color intensity will scale across 5 levels depending on how many points you log.

    ```streak
    title: Pages Read
    mode: detailed
    ```

**How to use Detailed Mode:**
- **Quick Add:** Click (or press `Enter`/`Space`) on a day to instantly add **+1 point**.
- **Point Editor:** Open the precise popup editor to set an exact number, subtract points, or clear the day entirely.
  - *Desktop:* **Right-click** the cell (or press `Shift+F10`).
  - *Mobile:* **Long-press** the cell.

**Automated Task Processing (Detailed Mode Only):**
If you have an unchecked markdown task in the *same note* that contains the board's title, completing it will automatically add +1 point to today's streak. The plugin appends a date badge to prevent double-counting.
*   *Before:* `- [ ] Pages Read: chapter 4`
*   *After clicking the checkbox:* `- [x] Pages Read: chapter 4 ✅ 2026-08-29`

Unchecking the task again removes the badge, so it becomes completable once more. The point already logged for that day is kept — unchecking just resets the task, it doesn't undo your streak.

---

## 🎨 Customizing Colors & Stats

You can personalize the look of your heatmap using the `color` and `stats` parameters.

### Colors
Use the `color:` parameter to change the heatmap's highlight color. The plugin understands almost any standard color format. If you provide an invalid color, it safely falls back to the default green.

**Examples of accepted color formats:**
- **Hex Codes:** `color: #ff8c42` or `color: #39d353`
- **CSS Names:** `color: tomato` or `color: dodgerblue`
- **RGB Values:** `color: rgb(57, 211, 83)` or simply `color: 57, 211, 83`
- **Obsidian Theme Variables:** `color: var(--interactive-accent)` or simply `color: --interactive-accent` (This is great if you want the heatmap to change colors automatically when you switch Obsidian themes).

### Statistics
Use the `stats:` parameter to show your progress below the calendar.
- `stats: bar` – Displays a visual progress bar, total marked days, percentage of the year, and your longest streak.
- `stats: text` – Displays the same summary text, but without the visual progress bar.
- `stats: none` – (Default) Hides the statistics entirely.

*Note: The percentage is always calculated out of the full calendar year (365 or 366 days). In detailed mode, any day with 1 or more points counts as exactly "1 marked day" for your streak and percentage.*

---

## 🔧 Under the Hood (Technical Details)

- **100% Local Storage:** Your history is saved entirely offline inside a `data.json` file in the plugin's folder. Data is completely private and migrates automatically if you previously used version 1.1.
- **Native Localization:** The plugin automatically reads your active Obsidian language settings. Month names, weekday labels, and date formats will dynamically translate to your native language without any manual configuration.
- **Security:** Board titles and markdown contents are sanitized using Obsidian's secure DOM API to prevent XSS vulnerabilities.
- **Performance:** To handle large vaults and frequent clicks smoothly, the plugin caches file reads (with a bounded size) and debounces disk writes (300ms) to minimize I/O impact.

---

## 📦 Installation

This plugin is available in the unofficial Obsidian community plugins browser and can be downloaded and installed directly from there.

### Manual Installation
1. Download `main.js`, `styles.css`, and `manifest.json` from the **Releases** tab.
2. Create a folder in your vault at: `<your-vault>/.obsidian/plugins/streak-heatmap/`
3. Place the three downloaded files into this folder.
4. In Obsidian, go to **Settings → Community plugins**, refresh the installed plugins list, and enable **Streak Heatmap**.

## Acknowledgments

Thanks to [@FilipeSix](https://github.com/FilipeSix) for contributing to this release.

## 📄 License

Distributed under the [MIT License](LICENSE).

---
[![Made with Claude](https://img.shields.io/badge/Made%20with-Claude-orange)](https://claude.com)
[![Made with Gemini](https://img.shields.io/badge/Made%20with-Gemini-blue?logo=google-gemini&logoColor=white)](https://gemini.google.com)