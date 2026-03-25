// clooks interactive TUI dashboard for `clooks stats -i`
// Modern terminal UI using raw ANSI escape codes + Node readline

import { readFileSync, existsSync } from 'fs';
import { METRICS_FILE } from './constants.js';
import type { MetricEntry } from './types.js';

// --- ANSI helpers ---

const ESC = '\x1b';
const CSI = `${ESC}[`;

const ansi = {
  clearScreen: `${CSI}2J`,
  cursorHome: `${CSI}H`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  underline: `${CSI}4m`,
  reverse: `${CSI}7m`,
  reset: `${CSI}0m`,
  red: `${CSI}31m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  blue: `${CSI}34m`,
  magenta: `${CSI}35m`,
  cyan: `${CSI}36m`,
  white: `${CSI}37m`,
  dimWhite: `${CSI}2;37m`,
  bgBlue: `${CSI}44m`,
  eraseLine: `${CSI}2K`,
  moveTo(row: number, col: number): string {
    return `${CSI}${row};${col}H`;
  },
};

function write(s: string): void {
  process.stdout.write(s);
}

function getTermSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

// --- Data loading ---

function loadAllMetricEntries(): MetricEntry[] {
  if (!existsSync(METRICS_FILE)) return [];
  try {
    const raw = readFileSync(METRICS_FILE, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line) as MetricEntry);
  } catch {
    return [];
  }
}

// --- Aggregation helpers ---

interface EventAgg {
  event: string;
  fires: number;
  errors: number;
  avgMs: number;
  maxMs: number;
  handlers: HandlerAgg[];
}

interface HandlerAgg {
  handler: string;
  event: string;
  fires: number;
  errors: number;
  avgMs: number;
  maxMs: number;
}

interface AgentAgg {
  agent: string;
  fires: number;
  errors: number;
  avgMs: number;
  handlers: HandlerAgg[];
}

interface ProjectAgg {
  project: string;
  fires: number;
  errors: number;
  avgMs: number;
  handlers: HandlerAgg[];
}

function aggregateByEvent(entries: MetricEntry[]): EventAgg[] {
  const byEvent = new Map<string, MetricEntry[]>();
  for (const e of entries) {
    const arr = byEvent.get(e.event) ?? [];
    arr.push(e);
    byEvent.set(e.event, arr);
  }

  const result: EventAgg[] = [];
  for (const [event, evEntries] of byEvent) {
    const durations = evEntries.map((e) => e.duration_ms);
    const byHandler = new Map<string, MetricEntry[]>();
    for (const e of evEntries) {
      const arr = byHandler.get(e.handler) ?? [];
      arr.push(e);
      byHandler.set(e.handler, arr);
    }

    const handlers: HandlerAgg[] = [];
    for (const [handler, hEntries] of byHandler) {
      const hDurations = hEntries.map((e) => e.duration_ms);
      handlers.push({
        handler,
        event,
        fires: hEntries.length,
        errors: hEntries.filter((e) => !e.ok).length,
        avgMs: hDurations.reduce((a, b) => a + b, 0) / hDurations.length,
        maxMs: Math.max(...hDurations),
      });
    }
    handlers.sort((a, b) => b.avgMs - a.avgMs);

    result.push({
      event,
      fires: evEntries.length,
      errors: evEntries.filter((e) => !e.ok).length,
      avgMs: durations.reduce((a, b) => a + b, 0) / durations.length,
      maxMs: Math.max(...durations),
      handlers,
    });
  }

  return result.sort((a, b) => b.fires - a.fires);
}

function aggregateAllHandlers(entries: MetricEntry[]): HandlerAgg[] {
  const byHandler = new Map<string, MetricEntry[]>();
  for (const e of entries) {
    const arr = byHandler.get(e.handler) ?? [];
    arr.push(e);
    byHandler.set(e.handler, arr);
  }

  const result: HandlerAgg[] = [];
  for (const [handler, hEntries] of byHandler) {
    const durations = hEntries.map((e) => e.duration_ms);
    result.push({
      handler,
      event: hEntries[0].event,
      fires: hEntries.length,
      errors: hEntries.filter((e) => !e.ok).length,
      avgMs: durations.reduce((a, b) => a + b, 0) / durations.length,
      maxMs: Math.max(...durations),
    });
  }

  return result.sort((a, b) => b.avgMs - a.avgMs);
}

function aggregateByAgent(entries: MetricEntry[]): AgentAgg[] {
  // Group by actual agent_type field from metrics
  const byAgent = new Map<string, MetricEntry[]>();
  let hasAgentData = false;
  for (const e of entries) {
    const agent = e.agent_type ?? '';
    if (agent) hasAgentData = true;
    const arr = byAgent.get(agent) ?? [];
    arr.push(e);
    byAgent.set(agent, arr);
  }

  // If no entries have agent_type, return empty — the view will show a message
  if (!hasAgentData) return [];

  const result: AgentAgg[] = [];
  for (const [agent, aEntries] of byAgent) {
    if (!agent) continue; // skip entries with no agent
    const durations = aEntries.map((e) => e.duration_ms);
    const handlers = aggregateHandlersFrom(aEntries);
    result.push({
      agent,
      fires: aEntries.length,
      errors: aEntries.filter((e) => !e.ok).length,
      avgMs: durations.reduce((a, b) => a + b, 0) / durations.length,
      handlers,
    });
  }

  return result.sort((a, b) => b.fires - a.fires);
}

function aggregateByProject(entries: MetricEntry[]): ProjectAgg[] {
  const bySid = new Map<string, MetricEntry[]>();
  for (const e of entries) {
    const key = e.session_id ?? 'unknown';
    const arr = bySid.get(key) ?? [];
    arr.push(e);
    bySid.set(key, arr);
  }

  const result: ProjectAgg[] = [];
  for (const [sid, pEntries] of bySid) {
    const durations = pEntries.map((e) => e.duration_ms);
    const handlers = aggregateHandlersFrom(pEntries);
    const label = sid.length > 16 ? sid.slice(0, 8) + '..' + sid.slice(-8) : sid;
    result.push({
      project: label,
      fires: pEntries.length,
      errors: pEntries.filter((e) => !e.ok).length,
      avgMs: durations.reduce((a, b) => a + b, 0) / durations.length,
      handlers,
    });
  }

  return result.sort((a, b) => b.fires - a.fires);
}

function aggregateHandlersFrom(entries: MetricEntry[]): HandlerAgg[] {
  const byHandler = new Map<string, MetricEntry[]>();
  for (const e of entries) {
    const arr = byHandler.get(e.handler) ?? [];
    arr.push(e);
    byHandler.set(e.handler, arr);
  }

  const result: HandlerAgg[] = [];
  for (const [handler, hEntries] of byHandler) {
    const durations = hEntries.map((e) => e.duration_ms);
    result.push({
      handler,
      event: hEntries[0].event,
      fires: hEntries.length,
      errors: hEntries.filter((e) => !e.ok).length,
      avgMs: durations.reduce((a, b) => a + b, 0) / durations.length,
      maxMs: Math.max(...durations),
    });
  }

  return result.sort((a, b) => b.avgMs - a.avgMs);
}

// --- Fuzzy search ---

function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

// --- Color helpers ---

function colorMs(ms: number, text: string): string {
  if (ms < 5) return `${ansi.green}${text}${ansi.reset}`;
  if (ms <= 50) return `${ansi.yellow}${text}${ansi.reset}`;
  return `${ansi.red}${text}${ansi.reset}`;
}

function colorErrors(errors: number, text: string): string {
  if (errors === 0) return `${ansi.green}${text}${ansi.reset}`;
  return `${ansi.red}${text}${ansi.reset}`;
}

// --- Row formatting ---

// Strip ANSI codes for length calculation
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function pad(text: string, width: number, right = false): string {
  const visible = stripAnsi(text);
  const diff = width - visible.length;
  if (diff <= 0) return text;
  const spaces = ' '.repeat(diff);
  return right ? spaces + text : text + spaces;
}

function rpad(text: string, width: number): string {
  return pad(text, width, true);
}

// --- TUI State ---

type ViewName = 'events' | 'handlers' | 'agents' | 'projects';
const VIEW_ORDER: ViewName[] = ['events', 'handlers', 'agents', 'projects'];
const VIEW_LABELS: Record<ViewName, string> = {
  events: 'Events',
  handlers: 'Handlers',
  agents: 'Agents',
  projects: 'Projects',
};

interface TUIState {
  currentView: ViewName;
  selectedIndex: number;
  scrollOffset: number;
  drillDown: EventAgg | AgentAgg | ProjectAgg | null;
  searchMode: boolean;
  searchQuery: string;

  entries: MetricEntry[];
  eventAggs: EventAgg[];
  handlerAggs: HandlerAgg[];
  agentAggs: AgentAgg[];
  projectAggs: ProjectAgg[];
}

// --- Main TUI ---

export function launchDashboard(): void {
  const entries = loadAllMetricEntries();

  const state: TUIState = {
    currentView: 'events',
    selectedIndex: 0,
    scrollOffset: 0,
    drillDown: null,
    searchMode: false,
    searchQuery: '',
    entries,
    eventAggs: aggregateByEvent(entries),
    handlerAggs: aggregateAllHandlers(entries),
    agentAggs: aggregateByAgent(entries),
    projectAggs: aggregateByProject(entries),
  };

  // Setup terminal
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');
  write(ansi.hideCursor);
  write(ansi.clearScreen);

  // Cleanup on exit
  function cleanup(): void {
    write(ansi.showCursor);
    write(ansi.clearScreen);
    write(ansi.cursorHome);
    process.stdin.setRawMode(false);
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Handle resize
  process.stdout.on('resize', () => render(state));

  // Input handling
  process.stdin.on('data', (key: string) => {
    if (state.searchMode) {
      handleSearchInput(state, key, cleanup);
    } else {
      handleNormalInput(state, key, cleanup);
    }
    render(state);
  });

  // Initial render
  render(state);
}

function handleNormalInput(state: TUIState, key: string, cleanup: () => void): void {
  // q or Ctrl+C: quit
  if (key === 'q' || key === '\x03') {
    cleanup();
    return;
  }

  // Tab: next view
  if (key === '\t') {
    switchView(state, 1);
    return;
  }

  // Shift+Tab (ESC [ Z)
  if (key === `${ESC}[Z`) {
    switchView(state, -1);
    return;
  }

  // Arrow up / k
  if (key === `${ESC}[A` || key === 'k') {
    if (state.selectedIndex > 0) state.selectedIndex--;
    adjustScroll(state);
    return;
  }

  // Arrow down / j
  if (key === `${ESC}[B` || key === 'j') {
    const maxIdx = getRowCount(state) - 1;
    if (state.selectedIndex < maxIdx) state.selectedIndex++;
    adjustScroll(state);
    return;
  }

  // Enter: drill in
  if (key === '\r') {
    drillIn(state);
    return;
  }

  // Escape or Backspace: go back
  if (key === ESC || key === '\x7f') {
    goBack(state);
    return;
  }

  // /: search mode
  if (key === '/') {
    state.searchMode = true;
    state.searchQuery = '';
    return;
  }

  // 1-4: direct tab selection
  if (key >= '1' && key <= '4') {
    const idx = parseInt(key) - 1;
    state.drillDown = null;
    state.currentView = VIEW_ORDER[idx];
    state.selectedIndex = 0;
    state.scrollOffset = 0;
    return;
  }
}

function handleSearchInput(state: TUIState, key: string, _cleanup: () => void): void {
  // Escape: cancel search
  if (key === ESC || key === '\x03') {
    state.searchMode = false;
    state.searchQuery = '';
    return;
  }

  // Enter: accept search and stay on filtered view
  if (key === '\r') {
    state.searchMode = false;
    return;
  }

  // Backspace
  if (key === '\x7f') {
    state.searchQuery = state.searchQuery.slice(0, -1);
    state.selectedIndex = 0;
    state.scrollOffset = 0;
    return;
  }

  // Printable character
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    state.searchQuery += key;
    state.selectedIndex = 0;
    state.scrollOffset = 0;
  }
}

function switchView(state: TUIState, direction: 1 | -1): void {
  state.drillDown = null;
  state.searchQuery = '';
  const idx = VIEW_ORDER.indexOf(state.currentView);
  const next = (idx + direction + VIEW_ORDER.length) % VIEW_ORDER.length;
  state.currentView = VIEW_ORDER[next];
  state.selectedIndex = 0;
  state.scrollOffset = 0;
}

function drillIn(state: TUIState): void {
  if (state.drillDown) return; // already drilled in

  if (state.currentView === 'events') {
    const ev = state.eventAggs[state.selectedIndex];
    if (ev) { state.drillDown = ev; state.selectedIndex = 0; state.scrollOffset = 0; }
  } else if (state.currentView === 'agents') {
    const ag = state.agentAggs[state.selectedIndex];
    if (ag) { state.drillDown = ag; state.selectedIndex = 0; state.scrollOffset = 0; }
  } else if (state.currentView === 'projects') {
    const pr = state.projectAggs[state.selectedIndex];
    if (pr) { state.drillDown = pr; state.selectedIndex = 0; state.scrollOffset = 0; }
  }
}

function goBack(state: TUIState): void {
  if (state.searchQuery) {
    state.searchQuery = '';
    state.selectedIndex = 0;
    state.scrollOffset = 0;
    return;
  }
  if (state.drillDown) {
    state.drillDown = null;
    state.selectedIndex = 0;
    state.scrollOffset = 0;
  }
}

function getRowCount(state: TUIState): number {
  const rows = getRows(state);
  return rows.length;
}

function adjustScroll(state: TUIState): void {
  const { rows } = getTermSize();
  const contentHeight = rows - 6; // header(2) + separator(1) + footer separator(1) + footer(2)
  if (state.selectedIndex < state.scrollOffset) {
    state.scrollOffset = state.selectedIndex;
  } else if (state.selectedIndex >= state.scrollOffset + contentHeight) {
    state.scrollOffset = state.selectedIndex - contentHeight + 1;
  }
}

// --- Row generation ---

interface Row {
  label: string;     // display text (may contain ANSI)
  isHeader?: boolean; // column header row (not selectable, rendered dim)
}

function getRows(state: TUIState): Row[] {
  const query = state.searchQuery.toLowerCase();

  if (state.entries.length === 0) {
    return [
      { label: 'No metrics recorded yet.' },
      { label: '' },
      { label: 'Start the clooks daemon and run some Claude Code sessions' },
      { label: 'to see hook execution statistics here.' },
    ];
  }

  if (state.currentView === 'events') {
    return getEventsRows(state, query);
  } else if (state.currentView === 'handlers') {
    return getHandlersRows(state, query);
  } else if (state.currentView === 'agents') {
    return getAgentsRows(state, query);
  } else {
    return getProjectsRows(state, query);
  }
}

function makeEventRow(ev: EventAgg): string {
  const name = pad(ev.event, 22);
  const fires = rpad(String(ev.fires), 8);
  const errs = colorErrors(ev.errors, rpad(String(ev.errors), 8));
  const avg = colorMs(ev.avgMs, rpad(ev.avgMs.toFixed(1), 9));
  const max = colorMs(ev.maxMs, rpad(ev.maxMs.toFixed(1), 9));
  return `${name}${fires}${errs}${avg}${max}`;
}

function makeHandlerRow(h: HandlerAgg): string {
  const name = pad(h.handler, 28);
  const ev = pad(h.event, 18);
  const fires = rpad(String(h.fires), 8);
  const errs = colorErrors(h.errors, rpad(String(h.errors), 8));
  const avg = colorMs(h.avgMs, rpad(h.avgMs.toFixed(1), 9));
  const max = colorMs(h.maxMs, rpad(h.maxMs.toFixed(1), 9));
  return `${name}${ev}${fires}${errs}${avg}${max}`;
}

function eventHeader(): Row {
  const name = pad('Event', 22);
  const fires = rpad('Fires', 8);
  const errs = rpad('Errors', 8);
  const avg = rpad('Avg ms', 9);
  const max = rpad('Max ms', 9);
  return { label: `${name}${fires}${errs}${avg}${max}`, isHeader: true };
}

function handlerHeader(): Row {
  const name = pad('Handler', 28);
  const ev = pad('Event', 18);
  const fires = rpad('Fires', 8);
  const errs = rpad('Errors', 8);
  const avg = rpad('Avg ms', 9);
  const max = rpad('Max ms', 9);
  return { label: `${name}${ev}${fires}${errs}${avg}${max}`, isHeader: true };
}

function getEventsRows(state: TUIState, query: string): Row[] {
  if (state.drillDown && 'event' in state.drillDown && 'handlers' in state.drillDown) {
    const ev = state.drillDown as EventAgg;
    const rows: Row[] = [handlerHeader()];
    for (const h of ev.handlers) {
      if (query && !fuzzyMatch(query, h.handler)) continue;
      rows.push({ label: makeHandlerRow(h) });
    }
    return rows;
  }

  const rows: Row[] = [eventHeader()];
  for (const ev of state.eventAggs) {
    if (query && !fuzzyMatch(query, ev.event)) continue;
    rows.push({ label: makeEventRow(ev) });
  }
  return rows;
}

function getHandlersRows(state: TUIState, query: string): Row[] {
  const rows: Row[] = [handlerHeader()];
  for (const h of state.handlerAggs) {
    if (query && !fuzzyMatch(query, h.handler) && !fuzzyMatch(query, h.event)) continue;
    rows.push({ label: makeHandlerRow(h) });
  }
  return rows;
}

function getAgentsRows(state: TUIState, query: string): Row[] {
  if (state.agentAggs.length === 0) {
    return [
      { label: 'No agent data available.' },
      { label: '' },
      { label: 'Agent tracking requires sessions launched with:' },
      { label: `  ${ansi.cyan}claude --agent <name>${ansi.reset}` },
      { label: '' },
      { label: 'The agent_type is recorded on SessionStart and' },
      { label: 'associated with all subsequent hook events in that session.' },
    ];
  }

  if (state.drillDown && 'agent' in state.drillDown) {
    const ag = state.drillDown as AgentAgg;
    const rows: Row[] = [handlerHeader()];
    for (const h of ag.handlers) {
      if (query && !fuzzyMatch(query, h.handler)) continue;
      rows.push({ label: makeHandlerRow(h) });
    }
    return rows;
  }

  const nameW = 22;
  const rows: Row[] = [{
    label: `${pad('Agent', nameW)}${rpad('Fires', 8)}${rpad('Errors', 8)}${rpad('Avg ms', 9)}${rpad('Handlers', 10)}`,
    isHeader: true,
  }];
  for (const ag of state.agentAggs) {
    if (query && !fuzzyMatch(query, ag.agent)) continue;
    const name = pad(ag.agent, nameW);
    const fires = rpad(String(ag.fires), 8);
    const errs = colorErrors(ag.errors, rpad(String(ag.errors), 8));
    const avg = colorMs(ag.avgMs, rpad(ag.avgMs.toFixed(1), 9));
    const hCount = rpad(String(ag.handlers.length), 10);
    rows.push({ label: `${name}${fires}${errs}${avg}${hCount}` });
  }
  return rows;
}

function getProjectsRows(state: TUIState, query: string): Row[] {
  if (state.drillDown && 'project' in state.drillDown) {
    const pr = state.drillDown as ProjectAgg;
    const rows: Row[] = [handlerHeader()];
    for (const h of pr.handlers) {
      if (query && !fuzzyMatch(query, h.handler)) continue;
      rows.push({ label: makeHandlerRow(h) });
    }
    return rows;
  }

  const nameW = 22;
  const rows: Row[] = [{
    label: `${pad('Session', nameW)}${rpad('Fires', 8)}${rpad('Errors', 8)}${rpad('Avg ms', 9)}`,
    isHeader: true,
  }];
  for (const pr of state.projectAggs) {
    if (query && !fuzzyMatch(query, pr.project)) continue;
    const name = pad(pr.project, nameW);
    const fires = rpad(String(pr.fires), 8);
    const errs = colorErrors(pr.errors, rpad(String(pr.errors), 8));
    const avg = colorMs(pr.avgMs, rpad(pr.avgMs.toFixed(1), 9));
    rows.push({ label: `${name}${fires}${errs}${avg}` });
  }
  return rows;
}

// --- Rendering ---

function render(state: TUIState): void {
  const { rows: termRows, cols } = getTermSize();
  const allRows = getRows(state);

  // Layout: line 1 = title + tabs, line 2 = separator, lines 3..N-3 = content,
  // line N-2 = separator, line N-1 = search/status, line N = keybindings
  const headerLines = 2;
  const footerLines = 3;
  const contentHeight = termRows - headerLines - footerLines;

  write(ansi.cursorHome);

  // --- Header line 1: title + tab bar ---
  const drillLabel = state.drillDown
    ? ` > ${('event' in state.drillDown) ? (state.drillDown as EventAgg).event :
        ('agent' in state.drillDown) ? (state.drillDown as AgentAgg).agent :
        (state.drillDown as ProjectAgg).project}`
    : '';

  let tabBar = '';
  for (const v of VIEW_ORDER) {
    if (v === state.currentView) {
      tabBar += `${ansi.reverse}${ansi.bold} ${VIEW_LABELS[v]} ${ansi.reset}  `;
    } else {
      tabBar += `${ansi.dim} ${VIEW_LABELS[v]} ${ansi.reset}  `;
    }
  }

  const searchIndicator = state.searchQuery
    ? `  ${ansi.yellow}/${state.searchQuery}${ansi.reset}`
    : '';

  const titleLeft = `  ${ansi.bold}clooks stats${ansi.reset}${drillLabel}`;
  const titleRight = `q: quit  `;
  const headerLine = titleLeft + searchIndicator
    + ' '.repeat(Math.max(1, cols - stripAnsi(titleLeft + searchIndicator).length - titleRight.length))
    + `${ansi.dim}${titleRight}${ansi.reset}`;

  write(ansi.eraseLine + headerLine + '\n');

  // Tabs line
  write(ansi.eraseLine + '  ' + tabBar + '\n');

  // --- Separator ---
  // (rendered as part of content area below)

  // --- Content ---
  // Adjust selectedIndex to skip header rows
  // Find the first non-header index
  let selectableStart = 0;
  for (let i = 0; i < allRows.length; i++) {
    if (!allRows[i].isHeader) { selectableStart = i; break; }
  }
  // Clamp selectedIndex to selectable rows only
  const selectableRows = allRows.filter(r => !r.isHeader);
  if (state.selectedIndex >= selectableRows.length) {
    state.selectedIndex = Math.max(0, selectableRows.length - 1);
  }

  // Map selectedIndex to absolute index in allRows
  let selectableCount = 0;
  let absSelectedIndex = -1;
  for (let i = 0; i < allRows.length; i++) {
    if (!allRows[i].isHeader) {
      if (selectableCount === state.selectedIndex) {
        absSelectedIndex = i;
        break;
      }
      selectableCount++;
    }
  }

  // Adjust scroll for absolute index
  if (absSelectedIndex >= 0) {
    if (absSelectedIndex < state.scrollOffset) {
      state.scrollOffset = absSelectedIndex;
    } else if (absSelectedIndex >= state.scrollOffset + contentHeight) {
      state.scrollOffset = absSelectedIndex - contentHeight + 1;
    }
  }
  // Ensure header row (index 0) is always visible by starting scroll at 0 min
  if (state.scrollOffset > 0 && allRows.length > 0 && allRows[0].isHeader) {
    // Keep the header pinned — we'll render it separately
  }

  // Render content rows
  const hasHeader = allRows.length > 0 && allRows[0].isHeader;
  let renderedLines = 0;

  if (hasHeader) {
    // Pin the column header
    const hdr = allRows[0].label;
    write(ansi.eraseLine + `  ${ansi.dim}${ansi.underline}${hdr}${ansi.reset}` + '\n');
    renderedLines++;
  }

  const dataStart = hasHeader ? 1 : 0;
  const visibleCount = contentHeight - renderedLines;
  // scrollOffset applies to data rows only (after header)
  const dataRows = allRows.slice(dataStart);
  const startIdx = state.scrollOffset;
  const endIdx = Math.min(dataRows.length, startIdx + visibleCount);

  // Map selected to data-relative index
  const dataSelectedIdx = absSelectedIndex >= 0 ? absSelectedIndex - dataStart : -1;

  for (let i = startIdx; i < endIdx; i++) {
    const row = dataRows[i];
    const isSelected = (i === dataSelectedIdx - state.scrollOffset + state.scrollOffset)
      // Simpler: is this data index === absSelectedIndex - dataStart?
      && false; // placeholder

    // Check if this data row is selected
    const selected = (i + dataStart) === absSelectedIndex;

    if (selected) {
      write(ansi.eraseLine + `  ${ansi.bold}${ansi.cyan}\u25b8${ansi.reset} ${ansi.bold}${row.label}${ansi.reset}` + '\n');
    } else {
      write(ansi.eraseLine + `    ${row.label}` + '\n');
    }
    renderedLines++;
  }

  // Fill remaining lines with blanks
  for (let i = renderedLines; i < contentHeight; i++) {
    write(ansi.eraseLine + '\n');
  }

  // --- Footer ---
  const totalFires = state.entries.length;
  const totalErrors = state.entries.filter(e => !e.ok).length;
  const totalEvents = state.eventAggs.length;
  const totalHandlers = state.handlerAggs.length;

  // Separator
  write(ansi.eraseLine + `  ${ansi.dim}${'─'.repeat(Math.max(0, cols - 4))}${ansi.reset}` + '\n');

  // Status line
  const statusInfo = `${totalEvents} events  ${totalHandlers} handlers  ${totalFires} fires  ${totalErrors} errors`;
  write(ansi.eraseLine + `  ${ansi.dim}${statusInfo}${ansi.reset}` + '\n');

  // Keybinding line
  let keyHelp: string;
  if (state.searchMode) {
    keyHelp = 'Type to filter  Enter: accept  Esc: cancel';
  } else if (state.drillDown) {
    keyHelp = 'Esc: back  Tab: switch view  j/k: navigate  /: search  q: quit';
  } else {
    keyHelp = 'Tab: switch view  j/k: navigate  Enter: drill in  /: search  1-4: jump to tab  q: quit';
  }
  write(ansi.eraseLine + `  ${ansi.dim}${keyHelp}${ansi.reset}`);

  // If in search mode, show the cursor in the search field
  if (state.searchMode) {
    // Position cursor at the search indicator in header
    write(ansi.showCursor);
  } else {
    write(ansi.hideCursor);
  }
}
