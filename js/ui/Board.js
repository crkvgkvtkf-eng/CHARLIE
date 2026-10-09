// The flow-chart board (SPEC §9.3): topic columns → joke cards → alt cards, with CSS connector
// lines, per-card menus, drag & drop grips, the mobile pager and the per-device collapsed state
// (`ssb.ui.collapsed`, never part of the workspace). All data changes go through store.actions.
import { html, useState, useRef, useMemo, useEffect, useLayoutEffect, useCallback } from '../lib.js';
import { activeVersion, deliveredText } from '../model.js';
import { countWords, formatDuration, jokeSeconds, parseDuration, topicEstimate } from '../timing.js';
import { createDnd } from './dnd.js';
import {
  AutoTextarea, Icon, IconButton, Menu, TimeChip, focusField, jokeLabel, plural, readLocal, topicLabel,
  useDraft, useMountFocus, useUi, writeLocal,
} from './common.js';

const COLLAPSED_KEY = 'ssb.ui.collapsed';
/** Topic colour presets (stored by name; css/app.css maps each to a tint and a connector colour). */
export const TOPIC_COLORS = ['rose', 'amber', 'lime', 'teal', 'sky', 'violet'];
const FLASH_CLASS = 'flash';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Outline flash on a revealed card (SPEC §9.5); the animation is defined in CSS. */
function flash(el) {
  el.classList.remove(FLASH_CLASS);
  void el.offsetWidth; // restart the animation when the same card is revealed twice
  el.classList.add(FLASH_CLASS);
  el.addEventListener('animationend', () => el.classList.remove(FLASH_CLASS), { once: true });
}

/** Attaches a grip element to the drag controller for the lifetime of the card. */
function useGrip(dnd, gripRef, cardRef, kind, id) {
  useLayoutEffect(() => {
    const grip = gripRef.current;
    if (!grip) return undefined;
    dnd.attach(grip, { kind, id, cardEl: cardRef.current });
    return () => dnd.detach(grip);
  }, [dnd, kind, id]);
}

/**
 * @param {object} props
 * @param {object} props.ws                   workspace snapshot
 * @param {boolean} props.isMobile
 * @param {number} props.initialTopicIndex    page to show when the board (re)mounts on mobile
 * @param {(i: number) => void} props.onTopicIndexChange
 * @param {{ jokeId: string, nonce: number }|null} props.reveal   request to scroll to and flash a joke
 * @param {() => void} props.onRevealed
 */
export function Board({ ws, isMobile, initialTopicIndex = 0, onTopicIndexChange, reveal, onRevealed }) {
  const { store, focus } = useUi();
  const version = activeVersion(ws);
  const topics = version.topics;
  const boardRef = useRef(null);
  const scrollRequest = useRef(null); // { topicId } | { index }: page to show after the next render (mobile)
  const [activeIndex, setActiveIndex] = useState(initialTopicIndex);
  const [collapsed, setCollapsed] = useState(() => {
    const stored = readLocal(COLLAPSED_KEY, []);
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [];
  });

  const setCollapsedFor = useCallback((topicId, value) => {
    setCollapsed((prev) => {
      const next = value ? [...new Set([...prev, topicId])] : prev.filter((id) => id !== topicId);
      writeLocal(COLLAPSED_KEY, next);
      return next;
    });
  }, []);

  const setPositions = useMemo(() => new Map(version.set.jokeIds.map((id, i) => [id, i + 1])), [version.set.jokeIds]);

  // ----- mobile paging -------------------------------------------------------------------------

  const pageCount = topics.length + 1; // the trailing "+ Topic" page
  const scrollToPage = useCallback((index, behavior = 'instant') => {
    const el = boardRef.current;
    if (!el) return;
    const i = clamp(index, 0, pageCount - 1);
    el.scrollTo({ left: i * el.clientWidth, behavior });
    setActiveIndex(i);
    if (onTopicIndexChange) onTopicIndexChange(i);
  }, [pageCount, onTopicIndexChange]);

  const rafId = useRef(0);
  const onScroll = () => {
    if (!isMobile || rafId.current) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = 0;
      const el = boardRef.current;
      if (!el || el.clientWidth === 0) return;
      const i = clamp(Math.round(el.scrollLeft / el.clientWidth), 0, pageCount - 1);
      setActiveIndex((prev) => (prev === i ? prev : i));
      if (onTopicIndexChange) onTopicIndexChange(i);
    });
  };
  useEffect(() => () => cancelAnimationFrame(rafId.current), []);

  // Initial page when the board mounts (returning from another tab).
  useLayoutEffect(() => {
    if (isMobile) scrollToPage(initialTopicIndex);
    // Mount only: later page changes come from scroll events and explicit requests.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // After addTopic / moveTopic / deleteTopic: show the acted-on topic (or the nearest remaining one).
  useLayoutEffect(() => {
    const req = scrollRequest.current;
    if (!req) return;
    scrollRequest.current = null;
    if (!isMobile) return;
    const index = req.topicId ? topics.findIndex((t) => t.id === req.topicId) : req.index;
    scrollToPage(index < 0 ? topics.length : index);
  }, [topics, isMobile, scrollToPage]);

  // After addVersion / switchVersion: start at the first topic.
  const seenVersion = useRef(ws.activeVersionId);
  useLayoutEffect(() => {
    if (seenVersion.current === ws.activeVersionId) return;
    seenVersion.current = ws.activeVersionId;
    if (isMobile) scrollToPage(0);
  }, [ws.activeVersionId, isMobile, scrollToPage]);

  // Reveal a joke from the Set panel: expand its topic if needed, scroll to it, flash.
  useLayoutEffect(() => {
    if (!reveal) return;
    const topicIndex = topics.findIndex((t) => t.jokes.some((j) => j.id === reveal.jokeId));
    if (topicIndex === -1) {
      onRevealed();
      return;
    }
    const topic = topics[topicIndex];
    if (collapsed.includes(topic.id)) {
      setCollapsedFor(topic.id, false); // the effect runs again once the jokes are rendered
      return;
    }
    const el = boardRef.current && boardRef.current.querySelector(`[data-testid="joke-card"][data-id="${CSS.escape(reveal.jokeId)}"]`);
    if (el) {
      if (isMobile) scrollToPage(topicIndex);
      el.scrollIntoView({ block: 'center', inline: isMobile ? 'nearest' : 'center', behavior: isMobile ? 'instant' : 'smooth' });
      flash(el);
    }
    onRevealed();
  }, [reveal, collapsed, topics, isMobile, scrollToPage, setCollapsedFor, onRevealed]);

  // ----- drag & drop ---------------------------------------------------------------------------

  const dnd = useMemo(() => createDnd({
    onDrop({ kind, id, containerId, index }) {
      if (kind === 'topic') {
        store.actions.moveTopic(id, index);
        scrollRequest.current = { topicId: id };
      } else if (kind === 'joke') {
        store.actions.moveJoke(id, containerId, index);
      } else if (kind === 'alt') {
        store.actions.moveAlt(id, containerId, index);
      }
    },
    onPage(direction) {
      const el = boardRef.current;
      if (!el || el.clientWidth === 0) return;
      const current = Math.round(el.scrollLeft / el.clientWidth);
      const next = clamp(current + (direction === 'left' ? -1 : 1), 0, el.children.length - 1);
      el.scrollTo({ left: next * el.clientWidth, behavior: 'instant' });
      setActiveIndex(next);
    },
  }), [store]);
  useEffect(() => () => dnd.destroy(), [dnd]);

  // ----- topic-level actions -------------------------------------------------------------------

  const addTopic = () => {
    const id = store.actions.addTopic();
    focus.request(id, 'title');
    scrollRequest.current = { topicId: id };
  };
  const moveTopic = (topicId, toIndex) => {
    store.actions.moveTopic(topicId, toIndex);
    scrollRequest.current = { topicId };
  };
  const removeTopic = (topicId, index) => {
    store.actions.removeTopic(topicId);
    scrollRequest.current = { index: Math.max(0, Math.min(index, topics.length - 2)) };
  };

  if (topics.length === 0) {
    return html`<div class="board-wrap">
      <div class="empty-board" data-testid="empty-board">
        <div class="empty-art" aria-hidden="true"><span></span><span></span><span></span></div>
        <h2>Start with a topic</h2>
        <p>Topics hold jokes, jokes hold alternative takes. Tick jokes into your set and watch the clock.</p>
        <button type="button" class="btn btn-primary btn-lg" data-testid="add-topic" onClick=${addTopic}>+ Add your first topic</button>
      </div>
    </div>`;
  }

  return html`<div class="board-wrap">
    ${isMobile ? html`<${TopicPager} topics=${topics} activeIndex=${activeIndex} onPick=${(i) => scrollToPage(i, 'smooth')} />` : null}
    <div class="board" data-drop="topics" data-dnd-hscroll=${isMobile ? undefined : '1'} data-dnd-page=${isMobile ? '1' : undefined}
      ref=${boardRef} onScroll=${onScroll}>
      ${topics.map((topic, index) => html`<${TopicColumn} key=${topic.id} ws=${ws} version=${version} topic=${topic} index=${index}
        count=${topics.length} setPositions=${setPositions} dnd=${dnd} isMobile=${isMobile}
        collapsed=${collapsed.includes(topic.id)} onCollapse=${(v) => setCollapsedFor(topic.id, v)}
        onMove=${(to) => moveTopic(topic.id, to)} onRemove=${() => removeTopic(topic.id, index)} />`)}
      <div class="board-tail">
        <button type="button" class="btn add-topic" data-testid="add-topic" onClick=${addTopic}><${Icon} name="plus" size=${16} /> Topic</button>
      </div>
    </div>
  </div>`;
}

/** Mobile pager: one pill per topic plus the "+" page; tapping scrolls the board smoothly. */
function TopicPager({ topics, activeIndex, onPick }) {
  const ref = useRef(null);
  useEffect(() => {
    const active = ref.current && ref.current.querySelector('[aria-current="true"]');
    if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeIndex]);
  return html`<nav class="topic-pager" data-testid="topic-pager" aria-label="Topics" ref=${ref}>
    ${topics.map((topic, i) => html`<button type="button" key=${topic.id} class="pager-pill" data-testid="pager-pill" data-index=${i}
      data-color=${topic.color ?? undefined} aria-current=${i === activeIndex ? 'true' : undefined} onClick=${() => onPick(i)}>
      ${topicLabel(topic, i)}
    </button>`)}
    <button type="button" class="pager-pill pager-add" data-testid="pager-pill" data-index=${topics.length}
      aria-current=${topics.length === activeIndex ? 'true' : undefined} aria-label="Add topic page" onClick=${() => onPick(topics.length)}>+</button>
  </nav>`;
}

// ---------------------------------------------------------------------------
// Topic column

function TopicColumn({ ws, version, topic, index, count, setPositions, dnd, isMobile, collapsed, onCollapse, onMove, onRemove }) {
  const { store, focus, confirm } = useUi();
  const cardRef = useRef(null);
  const gripRef = useRef(null);
  const titleRef = useRef(null);
  const menuButtonRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [title, setTitle] = useDraft(topic.title);
  useGrip(dnd, gripRef, cardRef, 'topic', topic.id);
  useMountFocus(titleRef, topic.id, 'title');

  const estimate = topicEstimate(ws, topic.id);

  const addJoke = () => {
    const id = store.actions.addJoke(topic.id);
    focus.request(id, 'title');
    if (collapsed) onCollapse(false);
  };

  const onTitleInput = (e) => {
    setTitle(e.target.value);
    store.actions.updateTopic(topic.id, { title: e.target.value });
  };
  const onTitleKeyDown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = cardRef.current && cardRef.current.querySelector('[data-testid="joke-title"]');
    if (first) focusField(first);
    else addJoke();
  };

  const deleteTopic = async () => {
    const n = topic.jokes.length;
    const ok = await confirm({
      title: `Delete topic “${topicLabel(topic, index)}”?`,
      message: n ? `Its ${plural(n, 'joke')} will be deleted too (they leave the set). You can undo this.` : 'You can undo this.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) onRemove();
  };

  const swatches = [
    { label: 'No colour', action: 'color-none', swatch: null, checked: topic.color == null, onSelect: () => store.actions.updateTopic(topic.id, { color: null }) },
    ...TOPIC_COLORS.map((name) => ({
      label: name[0].toUpperCase() + name.slice(1),
      action: `color-${name}`,
      swatch: name,
      checked: topic.color === name,
      onSelect: () => store.actions.updateTopic(topic.id, { color: name }),
    })),
  ];
  const menuItems = [
    { label: 'Rename', action: 'rename', onSelect: () => focusField(titleRef.current) },
    { label: collapsed ? 'Expand jokes' : 'Collapse jokes', action: 'collapse', onSelect: () => onCollapse(!collapsed) },
    { label: 'Move left', action: 'move-left', disabled: index === 0, onSelect: () => onMove(index - 1) },
    { label: 'Move right', action: 'move-right', disabled: index === count - 1, onSelect: () => onMove(index + 1) },
    { divider: true },
    { header: 'Colour' },
    { label: 'Colour', swatches },
    { divider: true },
    { label: 'Delete topic', action: 'delete', danger: true, onSelect: deleteTopic },
  ];

  return html`<section class="topic-col" data-card data-testid="topic-card" data-id=${topic.id} data-color=${topic.color ?? undefined}
    ref=${cardRef} aria-label=${topicLabel(topic, index)}>
    <header class="topic-card" data-card-header>
      <button type="button" class="grip topic-grip" data-testid="topic-grip" aria-label="Drag to reorder topic" ref=${gripRef}><${Icon} name="grip" size=${18} /></button>
      <input class="topic-title" data-testid="topic-title" type="text" placeholder="Topic" value=${title} ref=${titleRef}
        onInput=${onTitleInput} onBlur=${() => store.breakCoalescing()} onKeyDown=${onTitleKeyDown} aria-label="Topic title" />
      <span class="chip topic-chip" data-testid="topic-chip">${estimate.inSet}/${estimate.total} in set · ${formatDuration(estimate.seconds)}</span>
      <${IconButton} icon="more" label="Topic menu" testid="topic-menu" buttonRef=${menuButtonRef} onClick=${() => setMenuOpen(true)} aria-haspopup="menu" aria-expanded=${menuOpen} />
      ${menuOpen ? html`<${Menu} anchor=${menuButtonRef.current} items=${menuItems} label="Topic menu" onClose=${() => setMenuOpen(false)} />` : null}
    </header>
    <div class="col-scroll">
      <div class="jokes ${collapsed ? 'is-collapsed' : ''}" data-drop="jokes" data-topic-id=${topic.id}>
        ${collapsed
          ? html`<button type="button" class="collapsed-note" onClick=${() => onCollapse(false)}>${plural(topic.jokes.length, 'joke')} hidden · Expand</button>`
          : topic.jokes.map((joke, i) => html`<${JokeCard} key=${joke.id} ws=${ws} version=${version} topic=${topic} joke=${joke} index=${i}
              count=${topic.jokes.length} position=${setPositions.get(joke.id) ?? null} dnd=${dnd} isMobile=${isMobile} />`)}
        <div class="add-row">
          <button type="button" class="btn add-btn" data-testid="add-joke" onClick=${addJoke}><${Icon} name="plus" size=${14} /> Joke</button>
        </div>
      </div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Joke card

function JokeCard({ ws, version, topic, joke, index, count, position, dnd, isMobile }) {
  const { store, focus, confirm, prompt, toaster } = useUi();
  const cardRef = useRef(null);
  const gripRef = useRef(null);
  const titleRef = useRef(null);
  const textRef = useRef(null);
  const menuButtonRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [altsOpen, setAltsOpen] = useState(true);
  const [title, setTitle] = useDraft(joke.title);
  const [text, setText] = useDraft(joke.text);
  useGrip(dnd, gripRef, cardRef, 'joke', joke.id);
  useMountFocus(titleRef, joke.id, 'title');
  useMountFocus(textRef, joke.id, 'text');

  const inSet = position !== null;
  const delivered = deliveredText(joke);
  const seconds = jokeSeconds(joke, ws.settings);
  const words = countWords(delivered);
  const overridden = Number.isFinite(joke.overrideSec);
  const hasAlts = joke.alts.length > 0;

  const onTitleInput = (e) => {
    setTitle(e.target.value);
    store.actions.updateJoke(joke.id, { title: e.target.value });
  };
  const onTextInput = (e) => {
    const value = e.target.value;
    const addedNewline = value.split('\n').length > text.split('\n').length;
    setText(value);
    store.actions.updateJoke(joke.id, { text: value });
    if (addedNewline) store.breakCoalescing(); // a new line ends the current undo run
  };
  const onTitleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      focusField(textRef.current);
    }
  };

  const addAlt = () => {
    const id = store.actions.addAlt(joke.id);
    focus.request(id, 'text');
    setAltsOpen(true);
  };

  const setManualTime = async () => {
    const answer = await prompt({
      title: 'Manual time',
      message: 'Time for this joke as m:ss (or seconds). Leave blank to go back to the word-count estimate.',
      defaultValue: overridden ? formatDuration(joke.overrideSec) : '',
      placeholder: 'm:ss',
      confirmLabel: 'Set',
    });
    if (answer === null) return;
    if (answer.trim() === '') {
      store.actions.updateJoke(joke.id, { overrideSec: null });
      return;
    }
    const sec = parseDuration(answer);
    if (sec === null) {
      toaster.show({ message: 'Enter a time like 1:30 or 90.' });
      return;
    }
    store.actions.updateJoke(joke.id, { overrideSec: sec });
  };

  const deleteJoke = async () => {
    if (joke.text.trim() !== '' || joke.alts.some((a) => a.text.trim() !== '')) {
      const ok = await confirm({
        title: `Delete “${jokeLabel(joke)}”?`,
        message: hasAlts ? `Its ${plural(joke.alts.length, 'alt')} go with it. You can undo this.` : 'You can undo this.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
    }
    store.actions.removeJoke(joke.id);
  };

  const otherTopics = version.topics.filter((t) => t.id !== topic.id);
  const menuItems = [
    { label: 'Add alt', action: 'add-alt', onSelect: addAlt },
    { label: overridden ? 'Change manual time…' : 'Set manual time…', action: 'manual-time', onSelect: setManualTime },
    {
      label: 'Move to topic…',
      action: 'move-to-topic',
      disabled: otherTopics.length === 0,
      submenu: otherTopics.map((t) => ({
        label: topicLabel(t, version.topics.indexOf(t)),
        target: t.id,
        swatch: t.color ?? undefined,
        onSelect: () => store.actions.moveJoke(joke.id, t.id),
      })),
    },
    { label: 'Move up', action: 'move-up', disabled: index === 0, onSelect: () => store.actions.moveJoke(joke.id, topic.id, index - 1) },
    { label: 'Move down', action: 'move-down', disabled: index === count - 1, onSelect: () => store.actions.moveJoke(joke.id, topic.id, index + 1) },
    { label: 'Duplicate joke', action: 'duplicate', onSelect: () => store.actions.duplicateJoke(joke.id) },
    { divider: true },
    { label: 'Delete joke', action: 'delete', danger: true, onSelect: deleteJoke },
  ];

  const radioName = `use-${joke.id}`;
  return html`<article class="joke-card ${inSet ? 'in-set' : ''}" data-card data-testid="joke-card" data-id=${joke.id} ref=${cardRef}>
    <div class="card-head" data-card-header>
      <div class="card-meta">
        <button type="button" class="grip" data-testid="joke-grip" aria-label="Drag to reorder joke" ref=${gripRef}><${Icon} name="grip" size=${18} /></button>
        <label class="pill inset-pill ${inSet ? 'on' : ''}">
          <input type="checkbox" data-testid="joke-inset" checked=${inSet} onChange=${() => store.actions.toggleInSet(joke.id)} aria-label="In set" />
          <span>In set</span>
        </label>
        ${inSet ? html`<span class="badge" data-testid="joke-badge" title="Position in set">#${position}</span>` : null}
        <span class="spacer"></span>
        <${TimeChip} seconds=${seconds} words=${words} overridden=${overridden} testid="joke-time" />
        <${IconButton} icon="more" label="Joke menu" testid="joke-menu" buttonRef=${menuButtonRef} onClick=${() => setMenuOpen(true)} aria-haspopup="menu" aria-expanded=${menuOpen} />
        ${menuOpen ? html`<${Menu} anchor=${menuButtonRef.current} items=${menuItems} label="Joke menu" onClose=${() => setMenuOpen(false)} />` : null}
      </div>
      <input class="joke-title" data-testid="joke-title" type="text" placeholder="Joke title" value=${title} ref=${titleRef}
        onInput=${onTitleInput} onBlur=${() => store.breakCoalescing()} onKeyDown=${onTitleKeyDown} aria-label="Joke title" />
    </div>
    <${AutoTextarea} class="joke-text" wrapClass="joke-text-wrap" value=${text} textareaRef=${textRef} data-testid="joke-text"
      placeholder="Write the joke as you'd say it…" aria-label="Joke text" onInput=${onTextInput} onBlur=${() => store.breakCoalescing()} />
    ${hasAlts ? html`<div class="alts-head">
      <label class="pill radio-pill ${joke.activeAltId === null ? 'on' : ''}">
        <input type="radio" name=${radioName} data-testid="use-original" checked=${joke.activeAltId === null}
          onChange=${() => store.actions.setActiveAlt(joke.id, null)} aria-label="Use the original text in the set" />
        <span>Use original</span>
      </label>
      <button type="button" class="alts-toggle" aria-expanded=${altsOpen} onClick=${() => setAltsOpen(!altsOpen)}>
        <${Icon} name="chevronDown" size=${14} /> ${plural(joke.alts.length, 'alt')}
      </button>
    </div>` : null}
    <div class="alts ${hasAlts ? 'has-alts' : ''} ${hasAlts && !altsOpen ? 'is-collapsed' : ''}" data-drop="alts" data-joke-id=${joke.id}>
      ${altsOpen ? joke.alts.map((alt, i) => html`<${AltCard} key=${alt.id} topic=${topic} joke=${joke} alt=${alt} index=${i} count=${joke.alts.length}
        radioName=${radioName} dnd=${dnd} isMobile=${isMobile} />`) : null}
      <div class="add-row add-alt-row">
        <button type="button" class="btn add-btn add-alt" data-testid="add-alt" onClick=${addAlt}><${Icon} name="plus" size=${14} /> Alt</button>
      </div>
    </div>
  </article>`;
}

// ---------------------------------------------------------------------------
// Alt card

function AltCard({ topic, joke, alt, index, count, radioName, dnd }) {
  const { store } = useUi();
  const cardRef = useRef(null);
  const gripRef = useRef(null);
  const textRef = useRef(null);
  const menuButtonRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [text, setText] = useDraft(alt.text);
  useGrip(dnd, gripRef, cardRef, 'alt', alt.id);
  useMountFocus(textRef, alt.id, 'text');

  const active = joke.activeAltId === alt.id;
  const onTextInput = (e) => {
    const value = e.target.value;
    const addedNewline = value.split('\n').length > text.split('\n').length;
    setText(value);
    store.actions.updateAlt(alt.id, { text: value });
    if (addedNewline) store.breakCoalescing();
  };

  const otherJokes = topic.jokes.filter((j) => j.id !== joke.id);
  const menuItems = [
    { label: 'Make this the main joke', action: 'promote', onSelect: () => store.actions.promoteAlt(alt.id) },
    {
      label: 'Move to joke…',
      action: 'move-to-joke',
      disabled: otherJokes.length === 0,
      submenu: otherJokes.map((j) => ({ label: jokeLabel(j), target: j.id, onSelect: () => store.actions.moveAlt(alt.id, j.id) })),
    },
    { label: 'Move up', action: 'move-up', disabled: index === 0, onSelect: () => store.actions.moveAlt(alt.id, joke.id, index - 1) },
    { label: 'Move down', action: 'move-down', disabled: index === count - 1, onSelect: () => store.actions.moveAlt(alt.id, joke.id, index + 1) },
    { divider: true },
    { label: 'Delete alt', action: 'delete', danger: true, onSelect: () => store.actions.removeAlt(alt.id) },
  ];

  return html`<div class="alt-card ${active ? 'active' : ''}" data-card data-testid="alt-card" data-id=${alt.id} ref=${cardRef}>
    <div class="card-head" data-card-header>
      <button type="button" class="grip" data-testid="alt-grip" aria-label="Drag to reorder alt" ref=${gripRef}><${Icon} name="grip" size=${16} /></button>
      <label class="pill radio-pill ${active ? 'on' : ''}">
        <input type="radio" name=${radioName} data-testid="alt-use" checked=${active}
          onChange=${() => store.actions.setActiveAlt(joke.id, alt.id)} aria-label="Use this alt in the set" />
        <span>Use this in set</span>
      </label>
      <span class="chip alt-chip">${countWords(alt.text)}w</span>
      <${IconButton} icon="more" label="Alt menu" testid="alt-menu" size=${18} buttonRef=${menuButtonRef} onClick=${() => setMenuOpen(true)} aria-haspopup="menu" aria-expanded=${menuOpen} />
      ${menuOpen ? html`<${Menu} anchor=${menuButtonRef.current} items=${menuItems} label="Alt menu" onClose=${() => setMenuOpen(false)} />` : null}
    </div>
    <${AutoTextarea} class="alt-text" wrapClass="alt-text-wrap" value=${text} textareaRef=${textRef} data-testid="alt-text"
      placeholder="Alternative wording…" aria-label="Alt text" onInput=${onTextInput} onBlur=${() => store.breakCoalescing()} />
  </div>`;
}
