/* Obsidian's global DOM helpers, reimplemented for the standalone shell.

   Shared code under src/ builds every element through Obsidian's prototype
   augmentations (createDiv 176x, createSpan 118x, createEl 64x, setText 34x,
   addClass 28x, removeClass 20x, empty 20x, toggleClass 17x, setAttr 6x,
   hasClass 5x, plus three bare `createDiv({...})` global calls in
   MessageRenderer). Obsidian installs those on Node/Element/HTMLElement at
   app start; they are ambient globals, never imports, so nothing in src/
   reveals the dependency. The desktop renderer therefore has to supply them
   itself before any shared module touches the DOM — renderer.ts calls
   installDomHelpers() as its first statement, and DesktopPlatform's
   constructor calls it again defensively.

   Invariants:
   - Behavior mirrors Obsidian's implementation, not a superset: same
     DomElementInfo key handling, same "info.parent overrides the receiver"
     rule, same prepend-vs-append rule, same null-clears-the-attribute rule
     in setAttr, same property (not attribute) assignment for value/type/
     placeholder/href. A divergence here surfaces as a silent layout bug in
     a file twenty modules away.
   - Idempotent: a second call is a no-op, so a double import can never
     reinstall over live prototypes.
   - Installed non-enumerably, so `for (const k in el)` over a DOM object
     behaves as it did before.
   - The `declare global` block mirrors obsidian.d.ts signature for
     signature. It is what makes the shared sources typecheck in the app
     project (which, unlike the plugin project, never pulls in the obsidian
     package); the identical shapes also mean it merges harmlessly if
     obsidian's own ambient globals ever land in the same program. */

declare global {
  interface DomElementInfo {
    /* Space-separated string or array of class names. */
    cls?: string | string[];
    text?: string | DocumentFragment;
    attr?: { [key: string]: string | number | boolean | null };
    title?: string;
    /* Overrides the receiver as the append target. */
    parent?: Node;
    value?: string;
    type?: string;
    prepend?: boolean;
    placeholder?: string;
    href?: string;
  }

  interface SvgElementInfo {
    cls?: string | string[];
    attr?: { [key: string]: string | number | boolean | null };
    parent?: Node;
    prepend?: boolean;
  }

  interface Node {
    detach(): void;
    empty(): void;
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      o?: DomElementInfo | string,
      callback?: (el: HTMLElementTagNameMap[K]) => void,
    ): HTMLElementTagNameMap[K];
    createDiv(o?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
    createSpan(o?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement;
    createSvg<K extends keyof SVGElementTagNameMap>(
      tag: K,
      o?: SvgElementInfo | string,
      callback?: (el: SVGElementTagNameMap[K]) => void,
    ): SVGElementTagNameMap[K];
  }

  interface Element extends Node {
    setText(val: string | DocumentFragment): void;
    addClass(...classes: string[]): void;
    removeClass(...classes: string[]): void;
    toggleClass(classes: string | string[], value: boolean): void;
    hasClass(cls: string): boolean;
    setAttr(qualifiedName: string, value: string | number | boolean | null): void;
  }

  interface HTMLElement extends Element {
    onClickEvent(
      this: HTMLElement,
      listener: (this: HTMLElement, ev: MouseEvent) => unknown,
      options?: boolean | AddEventListenerOptions,
    ): void;
  }

  function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    o?: DomElementInfo | string,
    callback?: (el: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K];
  function createDiv(o?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
  function createSpan(o?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement;
  function createSvg<K extends keyof SVGElementTagNameMap>(
    tag: K,
    o?: SvgElementInfo | string,
    callback?: (el: SVGElementTagNameMap[K]) => void,
  ): SVGElementTagNameMap[K];
  function createFragment(callback?: (el: DocumentFragment) => void): DocumentFragment;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/* ----- shared primitives ----------------------------------------------- */

function applyClasses(el: Element, cls: string | string[]): void {
  const tokens = Array.isArray(cls) ? cls : cls.split(/\s+/);
  for (const token of tokens) {
    if (token) el.classList.add(token);
  }
}

/* value / type / placeholder / href are assigned as element PROPERTIES, the
   way Obsidian does it. The distinction is load-bearing for <input>, where
   the property is the dirty value and the attribute only the default. An
   element without the property (a div handed `href`) just gains an inert
   expando — same as Obsidian. */
function assignProperty(el: HTMLElement, key: string, value: string): void {
  (el as unknown as Record<string, string>)[key] = value;
}

function setAttrImpl(this: Element, qualifiedName: string, value: string | number | boolean | null): void {
  if (value === null) {
    this.removeAttribute(qualifiedName);
    return;
  }
  this.setAttribute(qualifiedName, typeof value === "string" ? value : String(value));
}

function setTextImpl(this: Element, val: string | DocumentFragment): void {
  if (typeof val === "string") {
    this.textContent = val;
    return;
  }
  this.textContent = "";
  this.appendChild(val);
}

function emptyImpl(this: Node): void {
  while (this.firstChild) this.removeChild(this.firstChild);
}

function detachImpl(this: Node): void {
  this.parentNode?.removeChild(this);
}

function addClassImpl(this: Element, ...classes: string[]): void {
  for (const cls of classes) {
    if (cls) this.classList.add(cls);
  }
}

function removeClassImpl(this: Element, ...classes: string[]): void {
  for (const cls of classes) {
    if (cls) this.classList.remove(cls);
  }
}

function toggleClassImpl(this: Element, classes: string | string[], value: boolean): void {
  const tokens = Array.isArray(classes) ? classes : [classes];
  for (const cls of tokens) {
    if (cls) this.classList.toggle(cls, value);
  }
}

function hasClassImpl(this: Element, cls: string): boolean {
  return this.classList.contains(cls);
}

function onClickEventImpl(
  this: HTMLElement,
  listener: (this: HTMLElement, ev: MouseEvent) => unknown,
  options?: boolean | AddEventListenerOptions,
): void {
  this.addEventListener("click", listener as EventListener, options);
}

/* ----- element factories ------------------------------------------------ */

function applyElementInfo(el: HTMLElement, info: DomElementInfo): void {
  if (info.cls !== undefined) applyClasses(el, info.cls);
  if (info.text !== undefined) setTextImpl.call(el, info.text);
  if (info.attr !== undefined) {
    for (const [key, value] of Object.entries(info.attr)) setAttrImpl.call(el, key, value);
  }
  if (info.title !== undefined) el.setAttribute("title", info.title);
  if (info.value !== undefined) assignProperty(el, "value", info.value);
  if (info.type !== undefined) assignProperty(el, "type", info.type);
  if (info.placeholder !== undefined) assignProperty(el, "placeholder", info.placeholder);
  if (info.href !== undefined) assignProperty(el, "href", info.href);
}

/* `this` is the receiving node when called as a method and null when called
   through the global alias (module code is strict, so it is never coerced to
   window). `info.parent` wins over both; no parent at all means the caller
   gets a detached element, which is what `createDiv({...})` at global scope
   relies on. */
function attach(el: Element, receiver: unknown, info?: { parent?: Node; prepend?: boolean }): void {
  const parent = info?.parent ?? (receiver instanceof Node ? receiver : null);
  if (!parent) return;
  if (info?.prepend) parent.insertBefore(el, parent.firstChild);
  else parent.appendChild(el);
}

function createElImpl(
  this: unknown,
  tag: string,
  o?: DomElementInfo | string,
  callback?: (el: HTMLElement) => void,
): HTMLElement {
  const info = typeof o === "string" ? { cls: o } : o;
  const el = document.createElement(tag);
  if (info) applyElementInfo(el, info);
  attach(el, this, info);
  callback?.(el);
  return el;
}

function createDivImpl(this: unknown, o?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement {
  return createElImpl.call(this, "div", o, callback as ((el: HTMLElement) => void) | undefined) as HTMLDivElement;
}

function createSpanImpl(this: unknown, o?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement {
  return createElImpl.call(this, "span", o, callback as ((el: HTMLElement) => void) | undefined) as HTMLSpanElement;
}

function createSvgImpl(
  this: unknown,
  tag: string,
  o?: SvgElementInfo | string,
  callback?: (el: SVGElement) => void,
): SVGElement {
  const info = typeof o === "string" ? { cls: o } : o;
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  if (info?.cls !== undefined) applyClasses(el, info.cls);
  if (info?.attr !== undefined) {
    for (const [key, value] of Object.entries(info.attr)) setAttrImpl.call(el, key, value);
  }
  attach(el, this, info);
  callback?.(el);
  return el;
}

function createFragmentImpl(callback?: (el: DocumentFragment) => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  callback?.(frag);
  return frag;
}

/* ----- installation ----------------------------------------------------- */

function define(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

let installed = false;

export function installDomHelpers(): void {
  if (installed) return;
  installed = true;

  /* Obsidian declares the create* family on Node, so DocumentFragment and
     Document inherit them alongside HTMLElement. Keep the same host so a
     fragment built by createFragment() can still createDiv() into itself. */
  define(Node.prototype, "detach", detachImpl);
  define(Node.prototype, "empty", emptyImpl);
  define(Node.prototype, "createEl", createElImpl);
  define(Node.prototype, "createDiv", createDivImpl);
  define(Node.prototype, "createSpan", createSpanImpl);
  define(Node.prototype, "createSvg", createSvgImpl);

  define(Element.prototype, "setText", setTextImpl);
  define(Element.prototype, "addClass", addClassImpl);
  define(Element.prototype, "removeClass", removeClassImpl);
  define(Element.prototype, "toggleClass", toggleClassImpl);
  define(Element.prototype, "hasClass", hasClassImpl);
  define(Element.prototype, "setAttr", setAttrImpl);

  define(HTMLElement.prototype, "onClickEvent", onClickEventImpl);

  /* Bare `createDiv({...})` (MessageRenderer builds three detached
     containers that way) resolves to these. Bound to null so the receiver
     branch in attach() yields a detached element rather than <html>. */
  const g = globalThis as unknown as Record<string, unknown>;
  define(g, "createEl", (tag: string, o?: DomElementInfo | string, cb?: (el: HTMLElement) => void) =>
    createElImpl.call(null, tag, o, cb));
  define(g, "createDiv", (o?: DomElementInfo | string, cb?: (el: HTMLDivElement) => void) =>
    createDivImpl.call(null, o, cb));
  define(g, "createSpan", (o?: DomElementInfo | string, cb?: (el: HTMLSpanElement) => void) =>
    createSpanImpl.call(null, o, cb));
  define(g, "createSvg", (tag: string, o?: SvgElementInfo | string, cb?: (el: SVGElement) => void) =>
    createSvgImpl.call(null, tag, o, cb));
  define(g, "createFragment", createFragmentImpl);
}
