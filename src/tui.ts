// clooks interactive TUI dashboard for `clooks stats -i`

import blessed from 'blessed';
import { readFileSync, existsSync } from 'fs';
import { METRICS_FILE } from './constants.js';
import type { MetricEntry } from './types.js';

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
  // Group by session_id first, then infer agent from handler patterns
  // Since MetricEntry doesn't have agent_type, we group by session_id
  // and label sessions by the set of handlers that fired
  const bySid = new Map<string, MetricEntry[]>();
  for (const e of entries) {
    const sid = e.session_id ?? 'unknown';
    const arr = bySid.get(sid) ?? [];
    arr.push(e);
    bySid.set(sid, arr);
  }

  // Derive agent name from handler prefixes (e.g., "gsd-*" => "gsd", "cq-*" => "cq")
  const agentMap = new Map<string, MetricEntry[]>();
  for (const [_sid, sEntries] of bySid) {
    // Use the most common handler prefix as agent name
    const prefixes = new Map<string, number>();
    for (const e of sEntries) {
      const prefix = e.handler.split('-')[0] || e.handler;
      prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
    }
    let agent = 'unknown';
    let maxCount = 0;
    for (const [p, c] of prefixes) {
      if (c > maxCount) { agent = p; maxCount = c; }
    }
    const arr = agentMap.get(agent) ?? [];
    arr.push(...sEntries);
    agentMap.set(agent, arr);
  }

  const result: AgentAgg[] = [];
  for (const [agent, aEntries] of agentMap) {
    const handlers = aggregateHandlersFrom(aEntries);
    result.push({
      agent,
      fires: aEntries.length,
      errors: aEntries.filter((e) => !e.ok).length,
      handlers,
    });
  }

  return result.sort((a, b) => b.fires - a.fires);
}

function aggregateByProject(entries: MetricEntry[]): ProjectAgg[] {
  // MetricEntry doesn't have cwd, so we group by session_id and use 'unknown' for project
  // If entries had cwd, we'd group by that. For now, group by session_id as proxy.
  // Actually, let's check if there's a cwd-like field or group by session
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
    const label = sid.length > 16 ? sid.slice(0, 8) + '...' + sid.slice(-8) : sid;
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

// --- Color coding ---

function colorize(avgMs: number, text: string): string {
  if (avgMs < 5) return `{green-fg}${text}{/green-fg}`;
  if (avgMs <= 50) return `{yellow-fg}${text}{/yellow-fg}`;
  return `{red-fg}${text}{/red-fg}`;
}

function colorizeErrors(errors: number, text: string): string {
  if (errors === 0) return `{green-fg}${text}{/green-fg}`;
  return `{red-fg}${text}{/red-fg}`;
}

// --- TUI ---

type ViewName = 'events' | 'handlers' | 'agents' | 'projects' | 'search';
const VIEW_ORDER: ViewName[] = ['events', 'handlers', 'agents', 'projects'];
const VIEW_LABELS: Record<ViewName, string> = {
  events: 'Events',
  handlers: 'Handlers',
  agents: 'Agents',
  projects: 'Projects',
  search: 'Search',
};

export function launchDashboard(): void {
  const entries = loadAllMetricEntries();

  const eventAggs = aggregateByEvent(entries);
  const handlerAggs = aggregateAllHandlers(entries);
  const agentAggs = aggregateByAgent(entries);
  const projectAggs = aggregateByProject(entries);

  const totalFires = entries.length;
  const totalErrors = entries.filter((e) => !e.ok).length;
  const totalEvents = eventAggs.length;
  const totalHandlers = handlerAggs.length;

  // --- Screen setup ---
  const scr = blessed.screen({
    smartCSR: true,
    title: 'clooks stats',
    fullUnicode: true,
  });

  let currentView: ViewName = 'events';
  let drillDown: EventAgg | AgentAgg | ProjectAgg | null = null;
  let searchMode = false;
  let searchQuery = '';

  // --- Header (tab bar) ---
  const header = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
    },
  });
  scr.append(header);

  // --- Main list ---
  const mainList = blessed.list({
    top: 3,
    left: 0,
    width: '100%',
    height: '100%-6',
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    scrollable: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'blue' },
      selected: { bg: 'blue', fg: 'white', bold: true },
      item: { fg: 'white' },
    },
    scrollbar: {
      ch: ' ',
      style: { bg: 'blue' },
    },
  });
  scr.append(mainList);

  // --- Footer (status bar) ---
  const footer = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
    },
  });
  scr.append(footer);

  // --- Search input (hidden by default) ---
  const searchBox = blessed.textbox({
    bottom: 3,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'yellow' },
      fg: 'white',
    },
    label: ' Search (Esc to cancel) ',
    hidden: true,
    inputOnFocus: true,
  });
  scr.append(searchBox);

  // --- Rendering functions ---

  function renderHeader(): void {
    const tabs = VIEW_ORDER.map((v) => {
      if (v === currentView) return `{cyan-fg}{bold}[${VIEW_LABELS[v]}]{/bold}{/cyan-fg}`;
      return ` ${VIEW_LABELS[v]} `;
    });
    if (searchMode) tabs.push(`{yellow-fg}{bold}[Search]{/bold}{/yellow-fg}`);
    header.setContent(` ${tabs.join('  ')}`);
  }

  function renderFooter(): void {
    const statusLine = `Total: ${totalEvents} events | ${totalHandlers} handlers | ${totalFires} fires | ${totalErrors} errors`;
    const helpLine = 'Tab=switch view  /=search  Enter=drill in  Esc=back  q=quit';
    footer.setContent(` ${statusLine}\n ${helpLine}`);
  }

  function formatHandlerRow(h: HandlerAgg): string {
    const name = h.handler.padEnd(28);
    const ev = h.event.padEnd(18);
    const fires = String(h.fires).padStart(6);
    const errs = colorizeErrors(h.errors, String(h.errors).padStart(6));
    const avg = colorize(h.avgMs, h.avgMs.toFixed(1).padStart(8));
    const max = colorize(h.maxMs, h.maxMs.toFixed(1).padStart(8));
    return ` ${name} ${ev} ${fires} ${errs} ${avg} ${max}`;
  }

  function handlerTableHeader(): string {
    const name = 'Handler'.padEnd(28);
    const ev = 'Event'.padEnd(18);
    const fires = 'Fires'.padStart(6);
    const errs = 'Errors'.padStart(6);
    const avg = 'Avg ms'.padStart(8);
    const max = 'Max ms'.padStart(8);
    return `{bold} ${name} ${ev} ${fires} ${errs} ${avg} ${max}{/bold}`;
  }

  function renderEventsView(): void {
    if (drillDown && 'event' in drillDown && 'handlers' in drillDown) {
      const ev = drillDown as EventAgg;
      mainList.setLabel(` Event: ${ev.event} `);
      const items = [handlerTableHeader()];
      for (const h of ev.handlers) {
        items.push(formatHandlerRow(h));
      }
      mainList.setItems(items);
    } else {
      mainList.setLabel(' Events ');
      const items: string[] = [];
      for (const ev of eventAggs) {
        const name = ev.event.padEnd(22);
        const fires = String(ev.fires).padStart(6);
        const errs = colorizeErrors(ev.errors, String(ev.errors).padStart(6));
        const avg = colorize(ev.avgMs, ev.avgMs.toFixed(1).padStart(8));
        const max = colorize(ev.maxMs, ev.maxMs.toFixed(1).padStart(8));
        const hCount = `(${ev.handlers.length} handlers)`.padStart(14);
        items.push(` ${name} ${fires} fires ${errs} errs ${avg} avg ${max} max ${hCount}`);
      }
      mainList.setItems(items);
    }
  }

  function renderHandlersView(): void {
    mainList.setLabel(' Handlers (sorted by avg latency) ');
    const items = [handlerTableHeader()];
    for (const h of handlerAggs) {
      items.push(formatHandlerRow(h));
    }
    mainList.setItems(items);
  }

  function renderAgentsView(): void {
    if (drillDown && 'agent' in drillDown) {
      const ag = drillDown as AgentAgg;
      mainList.setLabel(` Agent: ${ag.agent} `);
      const items = [handlerTableHeader()];
      for (const h of ag.handlers) {
        items.push(formatHandlerRow(h));
      }
      mainList.setItems(items);
    } else {
      mainList.setLabel(' Agents ');
      const items: string[] = [];
      for (const ag of agentAggs) {
        const name = ag.agent.padEnd(22);
        const fires = String(ag.fires).padStart(6);
        const errs = colorizeErrors(ag.errors, String(ag.errors).padStart(6));
        const hCount = `(${ag.handlers.length} handlers)`.padStart(14);
        items.push(` ${name} ${fires} fires ${errs} errs ${hCount}`);
      }
      mainList.setItems(items);
    }
  }

  function renderProjectsView(): void {
    if (drillDown && 'project' in drillDown) {
      const pr = drillDown as ProjectAgg;
      mainList.setLabel(` Session: ${pr.project} `);
      const items = [handlerTableHeader()];
      for (const h of pr.handlers) {
        items.push(formatHandlerRow(h));
      }
      mainList.setItems(items);
    } else {
      mainList.setLabel(' Projects / Sessions ');
      const items: string[] = [];
      for (const pr of projectAggs) {
        const name = pr.project.padEnd(22);
        const fires = String(pr.fires).padStart(6);
        const errs = colorizeErrors(pr.errors, String(pr.errors).padStart(6));
        const avg = colorize(pr.avgMs, pr.avgMs.toFixed(1).padStart(8));
        items.push(` ${name} ${fires} fires ${errs} errs ${avg} avg`);
      }
      mainList.setItems(items);
    }
  }

  function renderSearchView(): void {
    mainList.setLabel(` Search: "${searchQuery}" `);
    if (!searchQuery) {
      mainList.setItems([' Type to search handlers, events, agents...']);
      return;
    }

    const results: string[] = [handlerTableHeader()];

    // Search handlers
    for (const h of handlerAggs) {
      if (fuzzyMatch(searchQuery, h.handler) || fuzzyMatch(searchQuery, h.event)) {
        results.push(formatHandlerRow(h));
      }
    }

    // Search events
    for (const ev of eventAggs) {
      if (fuzzyMatch(searchQuery, ev.event) && !results.some((r) => r.includes(ev.event))) {
        const name = ev.event.padEnd(22);
        results.push(` {cyan-fg}[event]{/cyan-fg} ${name} ${ev.fires} fires`);
      }
    }

    // Search agents
    for (const ag of agentAggs) {
      if (fuzzyMatch(searchQuery, ag.agent)) {
        const name = ag.agent.padEnd(22);
        results.push(` {magenta-fg}[agent]{/magenta-fg} ${name} ${ag.fires} fires`);
      }
    }

    if (results.length === 1) {
      results.push(' No matches found.');
    }

    mainList.setItems(results);
  }

  function renderCurrentView(): void {
    renderHeader();
    renderFooter();

    switch (currentView) {
      case 'events': renderEventsView(); break;
      case 'handlers': renderHandlersView(); break;
      case 'agents': renderAgentsView(); break;
      case 'projects': renderProjectsView(); break;
      case 'search': renderSearchView(); break;
    }

    mainList.select(0);
    mainList.focus();
    scr.render();
  }

  function switchView(direction: 1 | -1): void {
    if (searchMode) {
      searchMode = false;
      searchBox.hide();
    }
    drillDown = null;
    const idx = VIEW_ORDER.indexOf(currentView);
    const next = (idx + direction + VIEW_ORDER.length) % VIEW_ORDER.length;
    currentView = VIEW_ORDER[next];
    renderCurrentView();
  }

  function drillInto(): void {
    // @ts-ignore — blessed ListElement exposes .selected at runtime
    const selected: number = mainList.selected ?? 0;

    if (currentView === 'events' && !drillDown) {
      const ev = eventAggs[selected];
      if (ev) { drillDown = ev; renderCurrentView(); }
    } else if (currentView === 'agents' && !drillDown) {
      const ag = agentAggs[selected];
      if (ag) { drillDown = ag; renderCurrentView(); }
    } else if (currentView === 'projects' && !drillDown) {
      const pr = projectAggs[selected];
      if (pr) { drillDown = pr; renderCurrentView(); }
    }
  }

  function goBack(): void {
    if (searchMode) {
      searchMode = false;
      searchBox.hide();
      currentView = 'events';
      renderCurrentView();
      return;
    }
    if (drillDown) {
      drillDown = null;
      renderCurrentView();
    }
  }

  // --- Key bindings ---
  scr.key(['q', 'C-c'], () => process.exit(0));

  scr.key(['tab'], () => switchView(1));
  scr.key(['S-tab'], () => switchView(-1));

  scr.key(['enter'], () => drillInto());
  scr.key(['escape', 'backspace'], () => goBack());

  scr.key(['/'], () => {
    searchMode = true;
    currentView = 'search';
    searchQuery = '';
    searchBox.show();
    searchBox.setValue('');
    renderCurrentView();
    searchBox.focus();
    searchBox.readInput(() => {
      // Input submitted
      searchQuery = searchBox.getValue();
      searchBox.hide();
      mainList.focus();
      renderCurrentView();
    });
    scr.render();
  });

  // Live search: update on each keypress in the search box
  searchBox.on('keypress', (_ch: string, _key: object) => {
    // Small delay to let blessed update the value
    setTimeout(() => {
      searchQuery = searchBox.getValue();
      renderSearchView();
      scr.render();
    }, 10);
  });

  // --- No data state ---
  if (entries.length === 0) {
    mainList.setItems([
      ' No metrics recorded yet.',
      '',
      ' Start the clooks daemon and run some Claude Code sessions',
      ' to see hook execution statistics here.',
    ]);
    mainList.setLabel(' clooks stats ');
    renderHeader();
    renderFooter();
    scr.render();
  } else {
    renderCurrentView();
  }
}
