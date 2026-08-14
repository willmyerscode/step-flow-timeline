/**
 * Step Flow Timeline Plugin for Squarespace
 * Transforms list sections into a sticky intro + numbered vertical timeline
 * Copyright Will-Myers.com
 **/

class WMStepFlowTimeline {
  static pluginName = 'step-flow-timeline';

  static emitEvent(type, detail = {}, elem = document) {
    elem.dispatchEvent(new CustomEvent(`wm-${this.pluginName}${type}`, { detail, bubbles: true }));
  }

  static allowedSectionDescriptionTags = new Set([
    'p',
    'span',
    'div',
    'h1',
    'h2',
    'h3',
    'h4'
  ]);

  static sectionDescriptionTagMappings = {
    p1: { tag: 'p', className: 'sqsrte-large' },
    p3: { tag: 'p', className: 'sqsrte-small' }
  };

  static sectionTitleBlockSelector = 'p, h1, h2, h3, h4, h5, h6';

  // Frames the scroll loop keeps running after the page stops moving.
  static idleFrameLimit = 12;

  // Height change (px) below which a touch-device resize is treated as the
  // browser UI collapsing rather than a real viewport change.
  static browserChromeHeightThreshold = 200;

  static resolveSectionDescriptionTag(tag) {
    const normalized = String(tag || 'p')
      .trim()
      .toLowerCase();
    const mapped = WMStepFlowTimeline.sectionDescriptionTagMappings[normalized];
    if (mapped) return mapped;
    return {
      tag: WMStepFlowTimeline.allowedSectionDescriptionTags.has(normalized) ? normalized : 'p',
      className: null
    };
  }

  constructor(el, settings = {}) {
    this.el = el;
    this.settings = {
      stickyOffset: null, // optional px/vh override; otherwise CSS --timeline-sticky-top
      sectionDescription: false, // split section title into a title + description
      sectionDescriptionTag: 'p', // tag used for the description (p, span, div, h1-h4, p1, p3)
      fadeInactiveItems: true, // fade the content of items the progress hasn't reached yet
      ...settings
    };
    this.data = null;
    this.sectionTitle = null;
    this.sectionButton = null;
    this.isSectionTitleEnabled = true;
    this.isSectionButtonEnabled = false;
    this.options = null;
    this.styles = null;
    this.originalContainer = null;
    this.pluginName = this.constructor.pluginName;
    this.isBackend = window.top !== window.self;
    this.timeline = null;
    this.progressFill = null;
    this.progressTrack = null;
    this.items = [];
    this.dots = [];
    this.metrics = null;
    this.needsMeasure = true;
    this.activeIndex = -1;
    this.lastProgress = null;
    this.viewportHeight = window.innerHeight;
    this.lastViewportWidth = window.innerWidth;
    this.lastScrollY = null;
    this.idleFrames = 0;
    this.rafId = null;
    this.isVisible = true;
    this.isTouch = window.matchMedia ? window.matchMedia('(hover: none)').matches : false;
    // When the browser can run the fill off a scroll timeline (see the
    // @supports block in the CSS), the compositor owns the bar and JS only
    // has to keep the per-item active states in sync.
    this.hasScrollTimeline = typeof CSS !== 'undefined'
      && typeof CSS.supports === 'function'
      && CSS.supports('animation-timeline', 'view()');
    this.scrollTimelineChecked = false;
    this.boundTick = null;
    this.boundHandleScroll = null;
    this.boundHandleResize = null;
    this.boundHandleRemeasure = null;
    this.resizeObserver = null;
    this.intersectionObserver = null;
    this.init();
  }

  init() {
    WMStepFlowTimeline.emitEvent(':beforeInit', { el: this.el }, this.el);
    this.addDataAttribute();
    this.extractData();
    if (!this.data || this.data.length === 0) return;
    this.removeOrHideOriginalListSectionContent();
    this.buildLayout();
    this.bindEvents();
    WMStepFlowTimeline.emitEvent(':afterInit', { el: this.el }, this.el);
  }

  addDataAttribute() {
    this.el.setAttribute('data-wm-plugin', this.pluginName);
    if (this.settings.fadeInactiveItems) {
      this.el.setAttribute('data-timeline-fade-inactive', 'true');
    }
  }

  extractData() {
    const container = this.el.querySelector('.user-items-list-item-container');
    if (!container || !container.dataset.currentContext) {
      console.error(`[${this.pluginName}] No data-current-context found`);
      return;
    }

    let contextData;
    try {
      contextData = JSON.parse(container.dataset.currentContext);
    } catch (error) {
      console.error(`[${this.pluginName}] Failed to parse data-current-context`, error);
      return;
    }

    this.originalContainer = container;
    this.data = contextData.userItems || [];
    this.options = contextData.options || {};
    this.styles = contextData.styles || {};
    this.sectionTitle = contextData.sectionTitle || null;
    this.sectionButton = contextData.sectionButton || null;
    this.isSectionTitleEnabled = contextData.isSectionTitleEnabled !== false;
    this.isSectionButtonEnabled = !!contextData.isSectionButtonEnabled;
  }

  removeOrHideOriginalListSectionContent() {
    const userItemsList = this.el.querySelector('.user-items-list');
    if (!userItemsList) return;
    userItemsList.style.display = 'none';
  }

  decodeHtml(html) {
    const txt = document.createElement('textarea');
    txt.innerHTML = html;
    return txt.value;
  }

  sanitizeTitleHtml(html) {
    if (!html) return '';
    const decoded = this.decodeHtml(html);
    const temp = document.createElement('div');
    temp.innerHTML = decoded;
    temp.querySelectorAll('p').forEach(p => {
      if (!p.textContent.trim() && !p.querySelector('img, video, iframe')) {
        p.remove();
      }
    });
    return temp.innerHTML;
  }

  getNativeSectionTitle() {
    return this.el.querySelector('.user-items-list .list-section-title');
  }

  getSectionTitleBlocks(root) {
    if (!root) return [];
    const blocks = [...root.querySelectorAll(WMStepFlowTimeline.sectionTitleBlockSelector)];
    if (blocks.length <= 1) return blocks;

    const groups = new Map();
    blocks.forEach((block) => {
      const parent = block.parentElement;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(block);
    });

    let bestGroup = [blocks[0]];
    groups.forEach((group) => {
      if (group.length > bestGroup.length) bestGroup = group;
    });
    return bestGroup.length > 1 ? bestGroup : blocks.slice(0, 1);
  }

  extractTextLinesFromElement(element) {
    const lines = [''];

    const appendText = (text) => {
      const parts = text.replace(/\r\n/g, '\n').split('\n');
      lines[lines.length - 1] += parts[0];
      for (let i = 1; i < parts.length; i += 1) {
        lines.push(parts[i]);
      }
    };

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        appendText(node.textContent);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === 'BR') {
        lines.push('');
        return;
      }
      node.childNodes.forEach(walk);
    };

    walk(element);
    return lines.map((line) => line.trim());
  }

  partsFromTitleLines(lines) {
    const trimmed = lines.map((line) => line.trim());
    while (trimmed.length && !trimmed[0]) trimmed.shift();
    while (trimmed.length && !trimmed[trimmed.length - 1]) trimmed.pop();
    if (!trimmed.length) return { title: '', description: '' };
    return {
      title: trimmed[0],
      description: trimmed.slice(1).join('\n').trim()
    };
  }

  parseSectionTitleFromRoot(root) {
    const blocks = this.getSectionTitleBlocks(root);
    if (blocks.length > 1) {
      return {
        title: blocks[0].textContent.trim(),
        description: blocks
          .slice(1)
          .map((block) => block.textContent.trim())
          .filter(Boolean)
          .join('\n')
      };
    }

    const source = blocks[0] || root;
    return this.partsFromTitleLines(this.extractTextLinesFromElement(source));
  }

  parseSectionTitleParts(html) {
    const native = this.getNativeSectionTitle();
    if (native) {
      const fromNative = this.parseSectionTitleFromRoot(native);
      if (fromNative.title || fromNative.description) return fromNative;
    }

    if (!html) return { title: '', description: '' };
    const root = document.createElement('div');
    root.innerHTML = this.decodeHtml(html);
    return this.parseSectionTitleFromRoot(root);
  }

  buildSectionTitleDefault() {
    const titleHtml = this.sanitizeTitleHtml(this.sectionTitle);
    if (!titleHtml) return null;

    const titleEl = document.createElement('div');
    titleEl.className = 'wm-step-flow-timeline-section-title list-section-title';

    const temp = document.createElement('div');
    temp.innerHTML = titleHtml;
    const paragraphs = [...temp.children].filter(child => child.tagName === 'P');

    if (paragraphs.length && paragraphs.length === temp.children.length) {
      const h2 = document.createElement('h2');
      h2.innerHTML = paragraphs
        .map(p => p.innerHTML.trim())
        .filter(Boolean)
        .join('<br>');
      titleEl.appendChild(h2);
    } else {
      titleEl.innerHTML = titleHtml;
    }
    return titleEl;
  }

  buildSectionTitleWithDescription() {
    const { title, description } = this.parseSectionTitleParts(this.sectionTitle);
    if (!title && !description) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'wm-step-flow-timeline-section-title';

    if (title) {
      const titleEl = document.createElement('h2');
      titleEl.className = 'wm-step-flow-timeline-section-title__title';
      titleEl.textContent = title;
      wrapper.appendChild(titleEl);
    }

    if (description) {
      const { tag, className } = WMStepFlowTimeline.resolveSectionDescriptionTag(
        this.settings.sectionDescriptionTag
      );
      const descriptionEl = document.createElement(tag);
      descriptionEl.className = 'wm-step-flow-timeline-section-title__description';
      if (className) descriptionEl.classList.add(className);
      descriptionEl.style.whiteSpace = 'pre-wrap';
      descriptionEl.textContent = description;
      wrapper.appendChild(descriptionEl);
    }

    return wrapper;
  }

  buildLayout() {
    const userItemsList = this.el.querySelector('.user-items-list');
    if (!userItemsList || !userItemsList.parentElement) return;

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'wm-plugin-content';

    const layout = document.createElement('div');
    layout.className = 'wm-step-flow-timeline-layout';

    // Left sticky column: section title + button
    const intro = document.createElement('div');
    intro.className = 'wm-step-flow-timeline-intro';

    if (this.settings.stickyOffset != null && this.settings.stickyOffset !== '') {
      const offset = typeof this.settings.stickyOffset === 'number'
        ? `${this.settings.stickyOffset}px`
        : this.settings.stickyOffset;
      intro.style.top = offset;
    }

    if (this.isSectionTitleEnabled && this.sectionTitle) {
      const titleEl = this.settings.sectionDescription
        ? this.buildSectionTitleWithDescription()
        : this.buildSectionTitleDefault();
      if (titleEl) intro.appendChild(titleEl);
    }

    if (this.isSectionButtonEnabled && this.sectionButton?.buttonText) {
      const buttonWrap = document.createElement('div');
      buttonWrap.className = 'wm-step-flow-timeline-section-button list-section-button-container';

      const button = document.createElement('a');
      button.className = 'wm-step-flow-timeline-button sqs-block-button-element sqs-button-element--secondary';
      button.href = this.sectionButton.buttonLink || '#';
      button.textContent = this.sectionButton.buttonText;
      if (this.sectionButton.buttonNewWindow) {
        button.target = '_blank';
        button.rel = 'noopener noreferrer';
      }

      buttonWrap.appendChild(button);
      intro.appendChild(buttonWrap);
    }

    // Right column: numbered timeline
    this.timeline = document.createElement('div');
    this.timeline.className = 'wm-step-flow-timeline';

    const track = document.createElement('div');
    track.className = 'wm-step-flow-timeline-track';
    this.progressTrack = track;

    const fill = document.createElement('div');
    fill.className = 'wm-step-flow-timeline-fill';
    this.progressFill = fill;
    track.appendChild(fill);

    const itemsList = document.createElement('div');
    itemsList.className = 'wm-step-flow-timeline-items';

    this.data.forEach((item, index) => {
      const itemEl = this.buildItem(item, index);
      itemsList.appendChild(itemEl);
      this.items.push(itemEl);
      const dot = itemEl.querySelector('.wm-step-flow-timeline-dot');
      if (dot) this.dots.push(dot);
    });

    this.timeline.appendChild(track);
    this.timeline.appendChild(itemsList);

    // When the intro has no content (no section title/description and no
    // button), center the timeline in the section instead of leaving an
    // empty left column.
    if (intro.childElementCount === 0) {
      layout.classList.add('wm-step-flow-timeline-layout--no-intro');
    } else {
      layout.appendChild(intro);
    }
    layout.appendChild(this.timeline);
    contentWrapper.appendChild(layout);
    userItemsList.insertAdjacentElement('afterend', contentWrapper);
  }

  buildItem(item, index) {
    const itemEl = document.createElement('div');
    itemEl.className = 'wm-step-flow-timeline-item';
    itemEl.dataset.index = index;

    const number = document.createElement('div');
    number.className = 'wm-step-flow-timeline-dot';
    number.textContent = String(index + 1);
    number.dataset.index = index;
    number.setAttribute('aria-hidden', 'true');

    let title = null;
    if (item.title && this.options?.isTitleEnabled !== false) {
      title = document.createElement('h3');
      title.className = 'wm-step-flow-timeline-item-title';
      title.textContent = item.title;
      // Opt out of Squarespace's site-wide animations. Heading elements are
      // auto-targeted by the global animation system, which stamps a
      // .fadeIn/.scaleIn/.slideIn class and forces `opacity: 1 !important`,
      // overriding the plugin's fadeInactiveItems dimming.
      title.setAttribute('data-override-initial-global-animation', 'true');
    }

    const content = document.createElement('div');
    content.className = 'wm-step-flow-timeline-item-content';
    content.setAttribute('data-override-initial-global-animation', 'true');

    if (item.description && this.options?.isBodyEnabled !== false) {
      const description = document.createElement('div');
      description.className = 'wm-step-flow-timeline-item-description';
      description.innerHTML = item.description;
      content.appendChild(description);
    }

    if (item.button?.buttonText && this.options?.isButtonEnabled !== false) {
      const buttonWrap = document.createElement('div');
      buttonWrap.className = 'wm-step-flow-timeline-item-button-wrapper';

      const button = document.createElement('a');
      button.className = 'wm-step-flow-timeline-item-button sqs-block-button-element sqs-button-element--secondary';
      button.href = item.button.buttonLink || '#';
      button.textContent = item.button.buttonText;
      if (item.button.buttonNewWindow) {
        button.target = '_blank';
        button.rel = 'noopener noreferrer';
      }

      buttonWrap.appendChild(button);
      content.appendChild(buttonWrap);
    }

    itemEl.appendChild(number);
    if (title) itemEl.appendChild(title);
    if (!title) itemEl.classList.add('wm-step-flow-timeline-item--no-title');
    itemEl.appendChild(content);
    return itemEl;
  }

  /**
   * Read every geometry value the scroll loop needs in one batch, then write the
   * track position once. All layout reads belong here: measuring per item while
   * scrolling forces a synchronous layout per item per frame, which is what made
   * the progress bar stutter on mobile Safari.
   */
  measure() {
    this.needsMeasure = false;

    if (!this.timeline || !this.progressTrack || this.dots.length === 0) {
      this.metrics = null;
      return;
    }

    // Read phase — no style writes until every rect has been collected.
    const timelineTop = this.timeline.getBoundingClientRect().top;
    const centers = this.items.map((item, index) => {
      const anchor = item.querySelector('.wm-step-flow-timeline-item-title') || this.dots[index];
      const rect = anchor.getBoundingClientRect();
      return rect.top - timelineTop + rect.height / 2;
    });

    // Align track to vertical centers of first/last title (or number)
    const firstDotTop = centers[0];
    const totalBarHeight = Math.max(0, centers[centers.length - 1] - firstDotTop);

    // Write phase — the track is absolutely positioned, so this cannot move the
    // anchors that were just measured.
    this.progressTrack.style.top = `${firstDotTop}px`;
    this.progressTrack.style.height = `${totalBarHeight}px`;

    this.metrics = {
      firstDotTop,
      totalBarHeight,
      // Progress value (0-1) at which each item becomes active.
      thresholds: centers.map(center => (
        totalBarHeight > 0 ? (center - firstDotTop) / totalBarHeight : 0
      ))
    };
  }

  /**
   * The CSS scroll timeline is only useful if the browser actually resolved it.
   * If it reports no current time the fill would sit frozen at scaleY(0), so
   * fall back to driving the transform from here.
   */
  verifyScrollTimeline() {
    if (this.scrollTimelineChecked) return;
    if (!this.progressFill || typeof this.progressFill.getAnimations !== 'function') {
      this.hasScrollTimeline = false;
      this.scrollTimelineChecked = true;
      return;
    }

    const isDriven = this.progressFill.getAnimations().some(animation => (
      animation.timeline
      && animation.timeline !== document.timeline
      && animation.timeline.currentTime !== null
    ));

    this.scrollTimelineChecked = true;
    if (!isDriven) {
      this.hasScrollTimeline = false;
      this.lastProgress = null;
      // Switches the CSS back to the transition-based fill this class drives.
      this.el.setAttribute('data-timeline-js-fill', 'true');
    }
  }

  updateProgress() {
    if (this.hasScrollTimeline) this.verifyScrollTimeline();
    if (this.needsMeasure) this.measure();

    const metrics = this.metrics;
    if (!metrics || !this.progressFill) return;

    let progress = 0;
    if (metrics.totalBarHeight > 0) {
      // The only layout read in the scroll path.
      const timelineTop = this.timeline.getBoundingClientRect().top;
      const scrollTrigger = this.viewportHeight * 0.5;
      const scrollProgress = (scrollTrigger - timelineTop - metrics.firstDotTop) / metrics.totalBarHeight;
      progress = Math.max(0, Math.min(1, scrollProgress));
    }

    if (progress !== this.lastProgress) {
      this.lastProgress = progress;
      if (!this.hasScrollTimeline) {
        this.progressFill.style.transform = `scaleY(${progress}) translateZ(0)`;
      }
    }

    // Thresholds ascend with the items, so the active item is the last one the
    // fill has reached and everything above it is active too.
    let activeIndex = 0;
    for (let i = 1; i < metrics.thresholds.length; i += 1) {
      if (progress < metrics.thresholds[i] - 0.001) break;
      activeIndex = i;
    }

    if (activeIndex !== this.activeIndex) {
      this.activeIndex = activeIndex;
      this.items.forEach((item, index) => {
        const isActive = index <= activeIndex;
        item.classList.toggle('wm-step-flow-timeline-item--active', isActive);
        this.dots[index]?.classList.toggle('wm-step-flow-timeline-dot--active', isActive);
      });
    }
  }

  /**
   * Keep a short-lived rAF loop running while the page moves. Mobile Safari
   * delivers scroll events unevenly during momentum scrolling, so updating
   * straight off the event makes the fill advance in visible steps; a frame loop
   * that idles out after the scroll settles keeps it on the display refresh.
   */
  requestTick() {
    if (this.rafId !== null) return;
    this.idleFrames = 0;
    this.rafId = requestAnimationFrame(this.boundTick);
  }

  tick() {
    this.rafId = null;

    const scrollY = window.scrollY;
    if (scrollY === this.lastScrollY) {
      this.idleFrames += 1;
    } else {
      this.lastScrollY = scrollY;
      this.idleFrames = 0;
    }

    this.updateProgress();

    if (this.isVisible && this.idleFrames < WMStepFlowTimeline.idleFrameLimit) {
      this.rafId = requestAnimationFrame(this.boundTick);
    }
  }

  bindEvents() {
    this.boundTick = () => this.tick();
    this.boundHandleScroll = () => this.requestTick();
    this.boundHandleRemeasure = () => {
      this.needsMeasure = true;
      this.requestTick();
    };

    let resizeTimeout;
    this.boundHandleResize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const widthChanged = width !== this.lastViewportWidth;

      // Mobile Safari fires resize as the URL bar collapses and expands during a
      // scroll. Adopting that height moves the trigger line mid-scroll and makes
      // the fill jump, so keep the cached height for small height-only changes.
      const isBrowserChrome = this.isTouch
        && !widthChanged
        && Math.abs(height - this.viewportHeight) < WMStepFlowTimeline.browserChromeHeightThreshold;

      this.lastViewportWidth = width;
      if (!isBrowserChrome) {
        this.viewportHeight = height;
        this.needsMeasure = true;
      }
      this.requestTick();

      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(this.boundHandleRemeasure, 100);
    };

    window.addEventListener('scroll', this.boundHandleScroll, { passive: true });
    window.addEventListener('resize', this.boundHandleResize, { passive: true });
    window.addEventListener('orientationchange', this.boundHandleRemeasure);
    window.addEventListener('load', this.boundHandleRemeasure);
    // Late-loading webfonts change title heights, which moves every anchor.
    document.fonts?.ready.then(this.boundHandleRemeasure).catch(() => {});

    if (typeof ResizeObserver !== 'undefined' && this.timeline) {
      this.resizeObserver = new ResizeObserver(this.boundHandleRemeasure);
      this.resizeObserver.observe(this.timeline);
    }

    if (typeof IntersectionObserver !== 'undefined' && this.timeline) {
      this.intersectionObserver = new IntersectionObserver(entries => {
        this.isVisible = entries.some(entry => entry.isIntersecting);
        if (this.isVisible) this.requestTick();
      }, { rootMargin: '20% 0px' });
      this.intersectionObserver.observe(this.timeline);
    }

    requestAnimationFrame(() => {
      this.needsMeasure = true;
      this.updateProgress();
    });
  }

  destroy() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.boundHandleScroll) {
      window.removeEventListener('scroll', this.boundHandleScroll);
    }
    if (this.boundHandleResize) {
      window.removeEventListener('resize', this.boundHandleResize);
    }
    if (this.boundHandleRemeasure) {
      window.removeEventListener('orientationchange', this.boundHandleRemeasure);
      window.removeEventListener('load', this.boundHandleRemeasure);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }

    const customContent = this.el.querySelector('.wm-plugin-content');
    if (customContent) customContent.remove();

    const userItemsList = this.el.querySelector('.user-items-list');
    if (userItemsList) {
      userItemsList.style.display = '';
    }

    this.el.removeAttribute('data-wm-plugin');
    this.el.removeAttribute('data-timeline-fade-inactive');
    this.el.removeAttribute('data-timeline-js-fill');
    this.timeline = null;
    this.progressFill = null;
    this.progressTrack = null;
    this.items = [];
    this.dots = [];
    this.metrics = null;
    this.needsMeasure = true;
    this.activeIndex = -1;
    this.lastProgress = null;

    WMStepFlowTimeline.emitEvent(':destroy', { el: this.el }, this.el);
  }
}

// Immediate initialization (no DOMContentLoaded)
(function () {
  const pluginName = 'step-flow-timeline';
  const sections = document.querySelectorAll(`[id^="${pluginName}"]`);
  const instances = [];

  sections.forEach(section => {
    const sectionId = section.id;
    const settings = window.wmStepFlowTimelineSettings?.[sectionId] || {};
    const instance = new WMStepFlowTimeline(section, settings);
    instances.push(instance);
  });

  if (window.top !== window.self) {
    const observer = new MutationObserver(() => {
      if (document.body.classList.contains('sqs-edit-mode-active')) {
        instances.forEach(instance => {
          if (instance && typeof instance.destroy === 'function') {
            instance.destroy();
          }
        });
        observer.disconnect();
      }
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class']
    });
  }
})();
