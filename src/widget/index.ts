import { getDomNodeCount, getRedactionCount, isFullPageDisabled } from './screenshot';
import { runScreenshotCaptureFlow } from './capture-flow';
import { injectStyles, createModal, showSuccessModal, type IssueLinkVisibility } from './ui';
import {
  resolveTheme,
  applyThemeClass,
  applyCustomStyles,
  attachSystemThemeListener,
  isValidTheme,
  type ThemeMode,
} from './theme';
import {
  escapeHtml,
  sanitizeCssColor,
  sanitizeCssFontFamily,
  sanitizeNonNegativeNumber,
  sanitizeNonNegativePixelValue,
  sanitizePositiveInteger,
  sanitizeShadowPreset,
  sanitizeUrl,
} from './sanitize';
import { resolveAccentColor } from '../defaults';

type FeedbackCategory = 'bug' | 'feature' | 'question';
type CategoryLabelConfig = Partial<Record<FeedbackCategory, string | string[]>>;

interface WidgetConfig {
  repo: string;
  apiUrl: string;
  position: 'bottom-right' | 'bottom-left';
  theme: 'light' | 'dark' | 'auto';
  // Name/email field configuration
  showName: boolean;
  requireName: boolean;
  showEmail: boolean;
  requireEmail: boolean;
  // Dismissible button configuration
  buttonDismissible: boolean;
  dismissDuration?: number; // Days before dismissed button reappears (undefined = forever)
  showRestore: boolean; // Show a pull tab after dismissing (default true when dismissible)
  // Button visibility (false = API-only mode)
  showButton: boolean;
  // Custom accent color (hex)
  accentColor?: string;
  // Custom icon URL (replaces default bug emoji), or 'none' to hide the icon
  iconUrl?: string;
  // Custom trigger button label text (default: 'Feedback')
  label?: string;
  // Optional mapping from built-in feedback categories to GitHub labels
  categoryLabels?: CategoryLabelConfig;
  // Tier 1 styling customization
  font?: string; // 'inherit' to use host page font, or a custom font-family string
  radius?: string; // Border radius in px (e.g., '0', '8', '16')
  bgColor?: string; // Background color override (e.g., '#fffef0')
  textColor?: string; // Text color override (e.g., '#1a1a1a')
  // Tier 2 styling customization
  borderWidth?: string; // Border width in px (e.g., '4')
  borderColor?: string; // Border color (e.g., '#1a1a1a')
  shadow?: string; // Shadow preset: 'none', 'soft' (default), 'hard'
  // Welcome screen behavior
  welcome: 'once' | 'always' | 'never';
  // Screenshot configuration
  screenshotMode: 'optional' | 'auto' | 'required';
  screenshotScale?: number; // Minimum pixel ratio for captures (default: 2)
  elementContextMaxArea?: number; // Max ancestor capture area as a viewport multiplier
  issueLinkVisibility: IssueLinkVisibility;
}

// BugDrop JavaScript API interface
interface BugDropAPI {
  open: () => void;
  close: () => void;
  hide: () => void;
  show: () => void;
  isOpen: () => boolean;
  isButtonVisible: () => boolean;
  setTheme: (mode: ThemeMode) => void;
}

// Declare global BugDrop API
declare global {
  interface Window {
    BugDrop?: BugDropAPI;
  }
}

interface FeedbackData {
  title: string;
  description: string;
  category: FeedbackCategory;
  screenshot: string | null;
  elementSelector: string | null;
  fullElementSelector: string | null;
  selectedElementHighlightColor: string | null;
  name?: string;
  email?: string;
}

// localStorage key for dismissed state
const BUGDROP_DISMISSED_KEY = 'bugdrop_dismissed';
const BUGDROP_WELCOMED_PREFIX = 'bugdrop_welcomed_';
const BUGDROP_COMPLEX_SCREENSHOT_SKIPPED_PREFIX = 'bugdrop_complex_screenshot_skipped_';
const COMPLEX_SCREENSHOT_SKIP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Parse user agent to extract browser info
function parseBrowser(ua: string): { name: string; version: string } {
  // Order matters - check more specific patterns first
  const browsers: Array<{ name: string; pattern: RegExp }> = [
    { name: 'Edge', pattern: /Edg(?:e|A|iOS)?\/(\d+[\d.]*)/ },
    { name: 'Opera', pattern: /(?:OPR|Opera)\/(\d+[\d.]*)/ },
    { name: 'Chrome', pattern: /Chrome\/(\d+[\d.]*)/ },
    { name: 'Safari', pattern: /Version\/(\d+[\d.]*).*Safari/ },
    { name: 'Firefox', pattern: /Firefox\/(\d+[\d.]*)/ },
  ];

  for (const { name, pattern } of browsers) {
    const match = ua.match(pattern);
    if (match) {
      return { name, version: match[1] || 'unknown' };
    }
  }

  return { name: 'Unknown', version: 'unknown' };
}

// Parse user agent to extract OS info
function parseOS(ua: string): { name: string; version: string } {
  const osPatterns: Array<{ name: string; pattern: RegExp; versionIndex?: number }> = [
    { name: 'iOS', pattern: /iPhone OS (\d+[_\d]*)/, versionIndex: 1 },
    { name: 'iOS', pattern: /iPad.*OS (\d+[_\d]*)/, versionIndex: 1 },
    { name: 'macOS', pattern: /Mac OS X (\d+[_.\d]*)/, versionIndex: 1 },
    { name: 'Windows', pattern: /Windows NT (\d+\.\d+)/, versionIndex: 1 },
    { name: 'Android', pattern: /Android (\d+[\d.]*)/, versionIndex: 1 },
    { name: 'Linux', pattern: /Linux/, versionIndex: undefined },
    { name: 'Chrome OS', pattern: /CrOS/, versionIndex: undefined },
  ];

  for (const { name, pattern, versionIndex } of osPatterns) {
    const match = ua.match(pattern);
    if (match) {
      const version =
        versionIndex !== undefined && match[versionIndex]
          ? match[versionIndex].replace(/_/g, '.')
          : '';
      return { name, version };
    }
  }

  return { name: 'Unknown', version: '' };
}

// Redact sensitive parts of URL (query params, common ID patterns)
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove query string and hash
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // If URL parsing fails, return as-is but try to strip query params
    return url.split('?')[0].split('#')[0];
  }
}

// Collect system info for feedback submission
function getSystemInfo(): {
  browser: { name: string; version: string };
  os: { name: string; version: string };
  devicePixelRatio: number;
  language: string;
  url: string;
} {
  const ua = navigator.userAgent;
  return {
    browser: parseBrowser(ua),
    os: parseOS(ua),
    devicePixelRatio: window.devicePixelRatio || 1,
    language: navigator.language || 'unknown',
    url: redactUrl(window.location.href),
  };
}

// Store widget state for API access
let _widgetRoot: HTMLElement | null = null;
let _triggerButton: HTMLElement | null = null;
let _pullTab: HTMLElement | null = null;
let _isModalOpen = false;
let _widgetConfig: WidgetConfig | null = null;

// Helper to check if button was dismissed
function isButtonDismissed(dismissDuration?: number): boolean {
  try {
    const dismissedAt = localStorage.getItem(BUGDROP_DISMISSED_KEY);
    if (!dismissedAt) return false;

    // Legacy support: if stored value is 'true', treat as permanently dismissed
    if (dismissedAt === 'true') return true;

    const timestamp = parseInt(dismissedAt, 10);
    if (isNaN(timestamp)) return false;

    // If no duration set, dismissed forever
    if (dismissDuration === undefined) return true;

    // Check if duration has passed (duration is in days)
    const durationMs = dismissDuration * 24 * 60 * 60 * 1000;
    return Date.now() - timestamp < durationMs;
  } catch {
    // localStorage may be blocked in some contexts
    return false;
  }
}

// Helper to dismiss the button
function dismissButton(): void {
  try {
    localStorage.setItem(BUGDROP_DISMISSED_KEY, Date.now().toString());
  } catch {
    // localStorage may be blocked in some contexts
  }
}

function hasSeenWelcome(repo: string): boolean {
  try {
    return localStorage.getItem(BUGDROP_WELCOMED_PREFIX + repo) !== null;
  } catch {
    return false;
  }
}

function markWelcomeSeen(repo: string): void {
  try {
    localStorage.setItem(BUGDROP_WELCOMED_PREFIX + repo, Date.now().toString());
  } catch {
    // localStorage may be blocked
  }
}

function getComplexScreenshotSkipKey(repo: string): string {
  return `${BUGDROP_COMPLEX_SCREENSHOT_SKIPPED_PREFIX}${repo}:${redactUrl(window.location.href)}`;
}

function hasSkippedComplexScreenshots(repo: string): boolean {
  try {
    const key = getComplexScreenshotSkipKey(repo);
    const skippedAt = localStorage.getItem(key);
    if (!skippedAt) return false;

    const timestamp = parseInt(skippedAt, 10);
    if (isNaN(timestamp) || Date.now() - timestamp > COMPLEX_SCREENSHOT_SKIP_TTL_MS) {
      localStorage.removeItem(key);
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function markComplexScreenshotsSkipped(repo: string): void {
  try {
    localStorage.setItem(getComplexScreenshotSkipKey(repo), Date.now().toString());
  } catch {
    // localStorage may be blocked
  }
}

function clearComplexScreenshotsSkipped(repo: string): void {
  try {
    localStorage.removeItem(getComplexScreenshotSkipKey(repo));
  } catch {
    // localStorage may be blocked
  }
}

function rememberComplexScreenshotSkip(config: WidgetConfig, formResult: FeedbackFormResult): void {
  if (!isFullPageDisabled()) return;
  markComplexScreenshotsSkipped(config.repo);
  formResult.includeScreenshot = false;
}

function parseCategoryLabels(rawValue: string | undefined): CategoryLabelConfig | undefined {
  if (!rawValue) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : '';
    console.warn(
      `[BugDrop] Invalid data-category-labels JSON${detail}. Using default GitHub labels.`
    );
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(
      '[BugDrop] Invalid data-category-labels: expected a JSON object. Using default GitHub labels.'
    );
    return undefined;
  }

  // Validate per-category shape so misconfig surfaces in browser DevTools rather
  // than only inside the issue body the operator may never read. The server
  // re-validates regardless — this layer exists for operator feedback.
  const knownCategories: FeedbackCategory[] = ['bug', 'feature', 'question'];
  const result: CategoryLabelConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!knownCategories.includes(key as FeedbackCategory)) {
      console.warn(
        `[BugDrop] Invalid data-category-labels: unknown category "${key}" (expected ${knownCategories.join(', ')}). Ignoring.`
      );
      continue;
    }
    if (typeof value === 'string') {
      result[key as FeedbackCategory] = value;
    } else if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
      result[key as FeedbackCategory] = value;
    } else {
      console.warn(
        `[BugDrop] Invalid data-category-labels: value for "${key}" must be a string or string array. Ignoring.`
      );
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// Read config from script tag (fallback to src-based lookup for async/defer)
const script = (document.currentScript ||
  document.querySelector('script[src*="bugdrop"][src*="widget"]')) as HTMLScriptElement;
if (!document.currentScript) {
  console.warn(
    '[BugDrop] document.currentScript is null — do not use async or defer on the BugDrop script tag.'
  );
}
const rawTheme = script?.dataset.theme;
if (rawTheme && !isValidTheme(rawTheme)) {
  console.warn(`[BugDrop] Invalid data-theme "${rawTheme}". Expected "light", "dark", or "auto".`);
}
const requireName = script?.dataset.requireName === 'true';
const requireEmail = script?.dataset.requireEmail === 'true';
const rawPosition = script?.dataset.position;
if (rawPosition && rawPosition !== 'bottom-right' && rawPosition !== 'bottom-left') {
  console.warn(
    `[BugDrop] Invalid data-position "${rawPosition}". Expected "bottom-right" or "bottom-left".`
  );
}
const rawDismissDuration = script?.dataset.dismissDuration;
const dismissDuration = sanitizePositiveInteger(rawDismissDuration);
if (rawDismissDuration && dismissDuration === undefined) {
  console.warn(
    '[BugDrop] Invalid data-dismiss-duration. Expected a positive whole number of days.'
  );
}
const rawScreenshotScale = script?.dataset.screenshotScale;
const screenshotScale = sanitizeNonNegativeNumber(rawScreenshotScale);
if (rawScreenshotScale && screenshotScale === undefined) {
  console.warn('[BugDrop] Invalid data-screenshot-scale. Expected a non-negative number.');
}
const rawElementContextMaxArea = script?.dataset.elementContextMaxArea;
const elementContextMaxArea = sanitizeNonNegativeNumber(rawElementContextMaxArea);
if (rawElementContextMaxArea && elementContextMaxArea === undefined) {
  console.warn('[BugDrop] Invalid data-element-context-max-area. Expected a non-negative number.');
}
const rawShadow = script?.dataset.shadow;
const shadow = sanitizeShadowPreset(rawShadow);
if (rawShadow && !shadow) {
  console.warn('[BugDrop] Invalid data-shadow. Expected "soft", "hard", or "none".');
}
const rawShowIssueLink = script?.dataset.showIssueLink;
const issueLinkVisibility: IssueLinkVisibility =
  rawShowIssueLink === 'always' || rawShowIssueLink === 'never' ? rawShowIssueLink : 'public';
if (rawShowIssueLink && rawShowIssueLink !== 'public' && rawShowIssueLink !== issueLinkVisibility) {
  console.warn(
    `[BugDrop] Invalid data-show-issue-link "${rawShowIssueLink}". Expected "public", "always", or "never".`
  );
}
const config: WidgetConfig = {
  repo: script?.dataset.repo || '',
  apiUrl: script?.src.replace(/\/widget(?:\.v[\d.]+)?\.js$/, '/api') || '',
  position: rawPosition === 'bottom-left' ? 'bottom-left' : 'bottom-right',
  theme: isValidTheme(rawTheme) ? rawTheme : 'auto', // Default to auto-detection
  // Name/email field configuration (all default to false for backwards compatibility)
  showName: script?.dataset.showName === 'true' || requireName,
  requireName,
  showEmail: script?.dataset.showEmail === 'true' || requireEmail,
  requireEmail,
  // Dismissible button configuration
  buttonDismissible: script?.dataset.buttonDismissible === 'true',
  dismissDuration,
  // Show restore pill after dismissing (default true when dismissible, unless explicitly false)
  showRestore: script?.dataset.showRestore !== 'false',
  // Button visibility (default true, set to false for API-only mode)
  showButton: script?.dataset.button !== 'false',
  // Custom accent color (e.g., "#FF6B35")
  accentColor: sanitizeCssColor(script?.dataset.color),
  // Custom icon URL (or 'none' to hide)
  iconUrl: sanitizeUrl(script?.dataset.icon),
  // Custom trigger label
  label: script?.dataset.label || undefined,
  categoryLabels: parseCategoryLabels(script?.dataset.categoryLabels),
  // Tier 1 styling customization
  font: sanitizeCssFontFamily(script?.dataset.font),
  radius: sanitizeNonNegativePixelValue(script?.dataset.radius)?.toString(),
  bgColor: sanitizeCssColor(script?.dataset.bg),
  textColor: sanitizeCssColor(script?.dataset.text),
  // Tier 2 styling customization
  borderWidth: sanitizeNonNegativePixelValue(script?.dataset.borderWidth)?.toString(),
  borderColor: sanitizeCssColor(script?.dataset.borderColor),
  shadow,
  // Welcome screen behavior (default: 'once')
  welcome: (() => {
    const val = script?.dataset.welcome;
    if (val === 'false' || val === 'never') return 'never' as const;
    if (val === 'always') return 'always' as const;
    return 'once' as const;
  })(),
  // Screenshot configuration
  screenshotMode: (() => {
    const val = script?.dataset.screenshot;
    if (val === 'auto' || val === 'required') return val;
    if (val && val !== 'optional') {
      console.warn(
        `[BugDrop] Invalid data-screenshot "${val}". Expected "optional", "auto", or "required".`
      );
    }
    return 'optional' as const;
  })(),
  screenshotScale,
  elementContextMaxArea,
  issueLinkVisibility,
};

// Validate config
if (!config.repo) {
  console.error('[BugDrop] Missing data-repo attribute');
} else if (!/^[^/]+\/[^/]+$/.test(config.repo)) {
  console.error(
    `[BugDrop] Invalid data-repo format "${config.repo}". Expected "owner/repo" (e.g., "octocat/hello-world").`
  );
} else {
  initWidget(config);
}

// Build the trigger button label text
function getTriggerLabel(config: WidgetConfig): string {
  return config.label !== undefined ? config.label : 'Feedback';
}

function appendTriggerContent(trigger: HTMLElement, config: WidgetConfig): void {
  if (config.iconUrl !== 'none') {
    const icon = document.createElement('span');
    icon.className = 'bd-trigger-icon';

    if (config.iconUrl) {
      const image = document.createElement('img');
      image.src = config.iconUrl;
      image.alt = '';
      const fallback = document.createElement('span');
      fallback.textContent = '🐛';
      fallback.style.display = 'none';
      image.addEventListener('error', () => {
        image.style.display = 'none';
        fallback.style.display = '';
      });
      icon.append(image, fallback);
    } else {
      icon.textContent = '🐛';
    }

    trigger.appendChild(icon);
  }

  const label = document.createElement('span');
  label.className = 'bd-trigger-label';
  label.textContent = getTriggerLabel(config);
  trigger.appendChild(label);
}

// Create the pull tab shown after dismissing the button
function createPullTab(root: HTMLElement, config: WidgetConfig): HTMLElement {
  const tab = document.createElement('div');
  tab.className =
    config.position === 'bottom-left' ? 'bd-pull-tab bd-pull-tab--left' : 'bd-pull-tab';
  tab.innerHTML = '<span class="bd-pull-tab-chevron">‹</span>';
  tab.setAttribute('role', 'button');
  tab.setAttribute('tabindex', '0');
  tab.setAttribute('aria-label', 'Show feedback button');

  const handleRestore = () => {
    // Clear dismissed state
    try {
      localStorage.removeItem(BUGDROP_DISMISSED_KEY);
    } catch {
      // localStorage may be blocked
    }

    // Remove the pull tab
    tab.remove();
    _pullTab = null;

    // Recreate the trigger button with restore animation
    createTriggerButton(root, config, true);
  };

  tab.addEventListener('click', handleRestore);
  tab.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleRestore();
    }
  });

  root.appendChild(tab);
  _pullTab = tab;
  return tab;
}

function initWidget(config: WidgetConfig) {
  // Store config for API access
  _widgetConfig = config;

  // If button is not dismissible, clear any stale dismissed state from localStorage
  // This ensures the button shows on non-dismissible pages even after visiting dismissible ones
  if (!config.buttonDismissible) {
    try {
      localStorage.removeItem(BUGDROP_DISMISSED_KEY);
    } catch {
      // localStorage may be blocked
    }
  }

  // Create Shadow DOM for style isolation
  const host = document.createElement('div');
  host.id = 'bugdrop-host';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  // Prevent keyboard events from leaking to host page (e.g., ERPNext console shortcuts)
  for (const eventType of ['keydown', 'keypress', 'keyup'] as const) {
    shadow.addEventListener(eventType, (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        e.stopPropagation();
      }
    });
  }

  // Inject styles and create root wrapper
  const root = injectStyles(shadow, config);
  _widgetRoot = root;

  // Determine if button should be rendered
  const shouldShowButton =
    config.showButton && !(config.buttonDismissible && isButtonDismissed(config.dismissDuration));

  if (shouldShowButton) {
    const trigger = document.createElement('button');
    trigger.className = 'bd-trigger';
    appendTriggerContent(trigger, config);
    trigger.setAttribute('aria-label', 'Report a bug or send feedback');

    // Add close button if dismissible
    if (config.buttonDismissible) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'bd-trigger-close';
      closeBtn.textContent = '×';
      closeBtn.setAttribute('aria-label', 'Dismiss feedback button');
      trigger.appendChild(closeBtn);

      // Handle close button click
      closeBtn.addEventListener('click', e => {
        e.stopPropagation(); // Don't trigger the main button
        dismissButton();

        // Remove restoring class if present (to avoid animation conflicts)
        trigger.classList.remove('bd-trigger--restoring');

        // Add dismiss animation
        trigger.classList.add('bd-trigger--dismissing');

        // Wait for animation to finish before removing
        trigger.addEventListener(
          'animationend',
          () => {
            trigger.remove();
            _triggerButton = null;

            // Show pull tab if enabled
            if (config.showRestore) {
              createPullTab(root, config);
            }
          },
          { once: true }
        );
      });
    }

    root.appendChild(trigger);
    _triggerButton = trigger;

    // Handle trigger click
    trigger.addEventListener('click', () => openFeedbackFlow(root, config));
  } else if (
    config.showButton &&
    config.buttonDismissible &&
    config.showRestore &&
    isButtonDismissed(config.dismissDuration)
  ) {
    // Button was previously dismissed - show pull tab
    createPullTab(root, config);
  }

  // Expose the BugDrop API
  exposeBugDropAPI(root, config);

  // Dispatch ready event
  window.dispatchEvent(new CustomEvent('bugdrop:ready'));
}

// Create and expose the BugDrop JavaScript API
function exposeBugDropAPI(root: HTMLElement, config: WidgetConfig) {
  // Closure-captured so each widget instance has its own mode state. Read by
  // the matchMedia listener below and mutated by setTheme. No module-level
  // state needed — keeps per-init isolation if multi-instance is ever added.
  let currentMode: ThemeMode = config.theme;

  window.BugDrop = {
    // Open the feedback modal programmatically
    open: () => {
      if (!_isModalOpen) {
        openFeedbackFlow(root, config, { skipWelcome: true });
      }
    },

    // Close the current modal
    close: () => {
      if (_isModalOpen) {
        // Find and remove any open modal
        const modal = root.querySelector('.bd-modal');
        if (modal) {
          modal.remove();
        }
        _isModalOpen = false;
      }
    },

    // Hide the floating button
    hide: () => {
      if (_triggerButton) {
        _triggerButton.style.display = 'none';
      }
    },

    // Show the floating button (clears dismissed state when called)
    show: () => {
      // Clear dismissed state when explicitly called
      try {
        localStorage.removeItem(BUGDROP_DISMISSED_KEY);
      } catch {
        // localStorage may be blocked
      }

      // Remove pull tab if present
      if (_pullTab) {
        _pullTab.remove();
        _pullTab = null;
      }

      if (_triggerButton) {
        _triggerButton.style.display = '';
      } else if (config.showButton) {
        // Recreate button if it was removed
        createTriggerButton(root, config);
      }
    },

    // Check if modal is currently open
    isOpen: () => _isModalOpen,

    // Check if floating button is visible
    isButtonVisible: () => {
      return _triggerButton !== null && _triggerButton.style.display !== 'none';
    },

    // Set the widget theme at runtime. Accepts 'light' | 'dark' | 'auto'.
    // Invalid input warns and no-ops. Only toggles the root class and re-runs
    // the custom-color inline styles — it does NOT re-inject the <style> block
    // because the dark-mode CSS variables are already defined statically in
    // `.bd-root.bd-dark { ... }` and get activated by the class flip alone.
    setTheme: (mode: unknown) => {
      if (!isValidTheme(mode)) {
        console.warn(
          `[BugDrop] Invalid theme ${String(mode)}. Expected 'light' | 'dark' | 'auto'.`
        );
        return;
      }
      currentMode = mode;
      const resolved = resolveTheme(mode);
      applyThemeClass(root, resolved);
      applyCustomStyles(root, config, resolved);
    },
  };

  // Fix for data-theme="auto" not following OS changes after init. One
  // persistent listener gated by `currentMode === 'auto'` so explicit
  // light/dark modes ignore OS changes. Cleanup fn is discarded — widgets
  // live for the page lifetime.
  attachSystemThemeListener(resolved => {
    if (currentMode !== 'auto') return;
    applyThemeClass(root, resolved);
    applyCustomStyles(root, config, resolved);
  });
}

// Helper to create the trigger button (used by show() API and pull tab restore)
function createTriggerButton(root: HTMLElement, config: WidgetConfig, isRestoring = false) {
  const trigger = document.createElement('button');
  trigger.className = isRestoring ? 'bd-trigger bd-trigger--restoring' : 'bd-trigger';
  appendTriggerContent(trigger, config);
  trigger.setAttribute('aria-label', 'Report a bug or send feedback');

  if (config.buttonDismissible) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'bd-trigger-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Dismiss feedback button');
    trigger.appendChild(closeBtn);

    closeBtn.addEventListener('click', e => {
      e.stopPropagation();
      dismissButton();

      // Remove restoring class if present (to avoid animation conflicts)
      trigger.classList.remove('bd-trigger--restoring');

      // Add dismiss animation
      trigger.classList.add('bd-trigger--dismissing');

      // Wait for animation to finish before removing
      trigger.addEventListener(
        'animationend',
        () => {
          trigger.remove();
          _triggerButton = null;

          // Show pull tab if enabled
          if (config.showRestore) {
            createPullTab(root, config);
          }
        },
        { once: true }
      );
    });
  }

  root.appendChild(trigger);
  _triggerButton = trigger;

  trigger.addEventListener('click', () => openFeedbackFlow(root, config));
}

async function openFeedbackFlow(
  root: HTMLElement,
  config: WidgetConfig,
  opts?: { skipWelcome?: boolean }
) {
  // Mark modal as open
  _isModalOpen = true;

  // Check if app is installed
  const { status: installStatus, appName } = await checkInstallation(config);
  if (installStatus === 'not_installed') {
    showInstallPrompt(root, config, undefined, appName);
    return;
  }
  if (installStatus === 'unreachable') {
    showInstallPrompt(
      root,
      config,
      'Unable to reach BugDrop API. Check your network connection or script tag URL.',
      appName
    );
    return;
  }

  // Step 1: Welcome screen (conditional)
  const skipWelcome =
    opts?.skipWelcome ||
    config.welcome === 'never' ||
    (config.welcome === 'once' && hasSeenWelcome(config.repo));

  if (!skipWelcome) {
    const continueFlow = await showWelcomeScreen(root);
    if (!continueFlow) {
      _isModalOpen = false;
      return;
    }
    if (config.welcome === 'once') {
      markWelcomeSeen(config.repo);
    }
  }

  let formResult: FeedbackFormResult | null = null;
  while (true) {
    // Step 2: Feedback form (with optional screenshot checkbox)
    formResult = await showFeedbackFormWithScreenshotOption(root, config, formResult);
    if (!formResult) {
      // User cancelled
      _isModalOpen = false;
      return;
    }

    const submittedFormResult = formResult;
    const screenshotResult = await runScreenshotCaptureFlow(
      root,
      config,
      submittedFormResult.includeScreenshot,
      () => rememberComplexScreenshotSkip(config, submittedFormResult)
    );

    if (screenshotResult.returnToForm) continue;

    // Submit
    await submitFeedback(root, config, {
      title: formResult.title,
      description: formResult.description,
      category: formResult.category,
      name: formResult.name,
      email: formResult.email,
      screenshot: screenshotResult.screenshot,
      elementSelector: screenshotResult.elementSelector,
      fullElementSelector: screenshotResult.fullElementSelector,
      selectedElementHighlightColor: screenshotResult.elementSelector
        ? resolveAccentColor(config.accentColor)
        : null,
    });
    break;
  }

  // Flow complete
  _isModalOpen = false;
}

async function checkInstallation(
  config: WidgetConfig
): Promise<{ status: 'installed' | 'not_installed' | 'unreachable'; appName?: string }> {
  try {
    const response = await fetch(`${config.apiUrl}/check/${config.repo}`);
    if (!response.ok) return { status: 'unreachable' };
    const data = await response.json();
    return {
      status: data.installed === true ? 'installed' : 'not_installed',
      appName: data.appName,
    };
  } catch {
    return { status: 'unreachable' };
  }
}

function showInstallPrompt(
  root: HTMLElement,
  config: WidgetConfig,
  errorMessage?: string,
  serverAppName?: string
) {
  const appName =
    serverAppName ||
    (config.apiUrl.includes('bugdrop.neonwatty.workers.dev')
      ? 'neonwatty-bugdrop'
      : config.apiUrl.replace(/https?:\/\//, '').replace(/\..*/, ''));
  const installUrl = `https://github.com/apps/${appName}/installations/new`;
  const message = errorMessage || 'BugDrop requires GitHub App installation to create issues.';
  const title = errorMessage ? 'Connection Error' : 'Install Required';
  const modal = createModal(
    root,
    title,
    `
      <p style="margin: 0 0 16px; color: var(--bd-text-secondary);">${message}</p>
      <div class="bd-actions">
        <button class="bd-btn bd-btn-secondary" data-action="cancel">Cancel</button>
        ${!errorMessage ? `<a href="${installUrl}" target="_blank" class="bd-btn bd-btn-primary" style="text-decoration: none;">Install App</a>` : ''}
      </div>
    `,
    true
  );

  const closeBtn = modal.querySelector('.bd-close') as HTMLElement;
  const cancelBtn = modal.querySelector('[data-action="cancel"]') as HTMLElement;

  closeBtn?.addEventListener('click', () => {
    modal.remove();
    _isModalOpen = false;
  });
  cancelBtn?.addEventListener('click', () => {
    modal.remove();
    _isModalOpen = false;
  });
}

function showWelcomeScreen(root: HTMLElement): Promise<boolean> {
  return new Promise(resolve => {
    const modal = createModal(
      root,
      'Share Your Feedback',
      `
        <div style="text-align: center; padding: 8px 0 16px;">
          <div style="font-size: 3rem; margin-bottom: 12px;">💬</div>
          <p style="margin: 0 0 12px; color: var(--bd-text-primary); font-size: 1.05rem; font-weight: 500;">
            Help us improve by sharing your thoughts
          </p>
          <p style="margin: 0 0 8px; color: var(--bd-text-secondary); font-size: 0.95rem; line-height: 1.6;">
            Report bugs, suggest features, or leave feedback.<br/>
            You can optionally include annotated screenshots.
          </p>
        </div>
        <div class="bd-actions" style="justify-content: center;">
          <button class="bd-btn bd-btn-primary" data-action="continue">Get Started</button>
        </div>
      `,
      true
    );

    const closeBtn = modal.querySelector('.bd-close') as HTMLElement;
    const continueBtn = modal.querySelector('[data-action="continue"]') as HTMLElement;

    closeBtn?.addEventListener('click', () => {
      modal.remove();
      resolve(false);
    });

    continueBtn?.addEventListener('click', () => {
      modal.remove();
      resolve(true);
    });
  });
}

interface FeedbackFormResult {
  title: string;
  description: string;
  category: FeedbackCategory;
  name?: string;
  email?: string;
  includeScreenshot: boolean;
}

function showFeedbackFormWithScreenshotOption(
  root: HTMLElement,
  config: WidgetConfig,
  initialValues?: FeedbackFormResult | null
): Promise<FeedbackFormResult | null> {
  return new Promise(resolve => {
    // Build optional name field
    const nameFieldHtml = config.showName
      ? `
          <div class="bd-form-group">
            <label class="bd-label" for="name">Name${config.requireName ? ' *' : ''}</label>
            <input type="text" id="name" class="bd-input" ${config.requireName ? 'required' : ''} placeholder="Your name" value="${escapeHtml(initialValues?.name || '')}" />
          </div>
        `
      : '';

    // Build optional email field
    const emailFieldHtml = config.showEmail
      ? `
          <div class="bd-form-group">
            <label class="bd-label" for="email">Email${config.requireEmail ? ' *' : ''}</label>
            <input type="email" id="email" class="bd-input" ${config.requireEmail ? 'required' : ''} placeholder="your@email.com" value="${escapeHtml(initialValues?.email || '')}" />
          </div>
        `
      : '';

    const modal = createModal(
      root,
      'Send Feedback',
      `
        <form id="feedback-form">
          <div class="bd-form-group">
            <label class="bd-label">Category</label>
            <div class="bd-category-selector" style="display: flex; gap: 8px; margin-top: 6px;">
              <label class="bd-category-option" style="flex: 1; display: flex; align-items: center; gap: 6px; padding: 8px 12px; border: var(--bd-border-style); border-radius: var(--bd-radius-sm); cursor: pointer; transition: all 0.15s ease;">
                <input type="radio" name="category" value="bug" ${getCategoryChecked(initialValues, 'bug')} style="accent-color: var(--bd-primary);" />
                <span style="font-size: 0.9rem;">🐛 Bug</span>
              </label>
              <label class="bd-category-option" style="flex: 1; display: flex; align-items: center; gap: 6px; padding: 8px 12px; border: var(--bd-border-style); border-radius: var(--bd-radius-sm); cursor: pointer; transition: all 0.15s ease;">
                <input type="radio" name="category" value="feature" ${getCategoryChecked(initialValues, 'feature')} style="accent-color: var(--bd-primary);" />
                <span style="font-size: 0.9rem;">✨ Feature</span>
              </label>
              <label class="bd-category-option" style="flex: 1; display: flex; align-items: center; gap: 6px; padding: 8px 12px; border: var(--bd-border-style); border-radius: var(--bd-radius-sm); cursor: pointer; transition: all 0.15s ease;">
                <input type="radio" name="category" value="question" ${getCategoryChecked(initialValues, 'question')} style="accent-color: var(--bd-primary);" />
                <span style="font-size: 0.9rem;">❓ Question</span>
              </label>
            </div>
          </div>
          <div class="bd-form-group">
            <label class="bd-label" for="title">Title *</label>
            <input type="text" id="title" class="bd-input" required placeholder="Brief description of the issue or suggestion" value="${escapeHtml(initialValues?.title || '')}" />
          </div>
          <div class="bd-form-group">
            <label class="bd-label" for="description">Description</label>
            <textarea id="description" class="bd-textarea" placeholder="Provide additional details, steps to reproduce, or context...">${escapeHtml(initialValues?.description || '')}</textarea>
          </div>
          ${nameFieldHtml}
          ${emailFieldHtml}
          ${getScreenshotFormControl(config, initialValues)}
          <div class="bd-actions">
            <button type="button" class="bd-btn bd-btn-secondary" data-action="cancel">Cancel</button>
            <button type="submit" class="bd-btn bd-btn-primary" id="submit-btn">${config.screenshotMode === 'auto' ? 'Submit' : 'Continue'}</button>
          </div>
        </form>
      `
    );

    const form = modal.querySelector('#feedback-form') as HTMLFormElement;
    const nameInput = modal.querySelector('#name') as HTMLInputElement | null;
    const emailInput = modal.querySelector('#email') as HTMLInputElement | null;
    const titleInput = modal.querySelector('#title') as HTMLInputElement;
    const descInput = modal.querySelector('#description') as HTMLTextAreaElement;
    const screenshotCheckbox = modal.querySelector(
      '#include-screenshot'
    ) as HTMLInputElement | null;
    const closeBtn = modal.querySelector('.bd-close') as HTMLElement;
    const cancelBtn = modal.querySelector('[data-action="cancel"]') as HTMLElement;

    const closeModal = () => {
      modal.remove();
      resolve(null);
    };

    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);

    form.addEventListener('submit', e => {
      e.preventDefault();

      // Validate required fields
      if (!titleInput.value.trim()) {
        titleInput.classList.add('bd-input--error');
        titleInput.focus();
        return;
      }

      // Validate name if required
      if (config.requireName && nameInput && !nameInput.value.trim()) {
        nameInput.classList.add('bd-input--error');
        nameInput.focus();
        return;
      }

      // Validate email if required
      if (config.requireEmail && emailInput && !emailInput.value.trim()) {
        emailInput.classList.add('bd-input--error');
        emailInput.focus();
        return;
      }

      // Get selected category
      const categoryInput = modal.querySelector(
        'input[name="category"]:checked'
      ) as HTMLInputElement;
      const category = (categoryInput?.value || 'bug') as FeedbackCategory;
      const includeScreenshot =
        config.screenshotMode === 'optional' ? (screenshotCheckbox?.checked ?? false) : true;
      if (config.screenshotMode === 'optional' && includeScreenshot) {
        clearComplexScreenshotsSkipped(config.repo);
      }

      modal.remove();
      resolve({
        title: titleInput.value.trim(),
        description: descInput.value.trim(),
        category,
        name: nameInput?.value.trim() || undefined,
        email: emailInput?.value.trim() || undefined,
        includeScreenshot,
      });
    });

    // Clear error styling on input
    titleInput.addEventListener('input', () => titleInput.classList.remove('bd-input--error'));
    nameInput?.addEventListener('input', () => nameInput.classList.remove('bd-input--error'));
    emailInput?.addEventListener('input', () => emailInput.classList.remove('bd-input--error'));
  });
}

function getScreenshotFormControl(
  config: WidgetConfig,
  initialValues?: FeedbackFormResult | null
): string {
  if (config.screenshotMode === 'auto') {
    const redactionNote =
      getRedactionCount() > 0
        ? ' Some fields this site marked private may be visually masked on supported pages, but unmarked sensitive information can still be included.'
        : '';
    return `
      <p style="margin: 8px 0 0; color: var(--bd-text-secondary); font-size: 0.95rem;">
        This site will attach a full-page screenshot when you submit without showing a preview. Review your page for sensitive information before sending.${redactionNote}
      </p>
    `;
  }

  if (config.screenshotMode === 'required') {
    return `
      <p style="margin: 8px 0 0; color: var(--bd-text-secondary); font-size: 0.95rem;">
        📸 A screenshot is required before submitting.
      </p>
    `;
  }

  const includeScreenshot =
    initialValues?.includeScreenshot ??
    (!isFullPageDisabled() || !hasSkippedComplexScreenshots(config.repo));

  return `
    <div class="bd-form-group" style="display: flex; align-items: center; gap: 10px; margin-top: 8px;">
      <input type="checkbox" id="include-screenshot" ${includeScreenshot ? 'checked' : ''} style="width: 18px; height: 18px; accent-color: var(--bd-primary); cursor: pointer;" />
      <label for="include-screenshot" style="font-size: 0.95rem; color: var(--bd-text-secondary); cursor: pointer; user-select: none;">
        📸 Include a screenshot
      </label>
    </div>
  `;
}

function getCategoryChecked(
  initialValues: FeedbackFormResult | null | undefined,
  category: FeedbackCategory
): string {
  return (initialValues?.category || 'bug') === category ? 'checked' : '';
}

async function submitFeedback(root: HTMLElement, config: WidgetConfig, data: FeedbackData) {
  // Show submitting modal with loading state
  const modal = createModal(
    root,
    'Submitting...',
    `
      <div style="display: flex; flex-direction: column; align-items: center; padding: 20px;">
        <div class="bd-spinner bd-spinner--lg"></div>
        <p class="bd-loading-text" style="margin-top: 12px;">Creating issue...</p>
      </div>
    `
  );

  try {
    // Build submitter info if provided
    const submitter = data.name || data.email ? { name: data.name, email: data.email } : undefined;

    // Collect system info
    const systemInfo = getSystemInfo();
    const domNodeCount = getDomNodeCount();

    const response = await fetch(`${config.apiUrl}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: config.repo,
        title: data.title,
        description: data.description,
        category: data.category,
        categoryLabels: config.categoryLabels,
        screenshot: data.screenshot,
        submitter,
        metadata: {
          url: systemInfo.url, // Redacted URL (no query params)
          userAgent: navigator.userAgent,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
          },
          timestamp: new Date().toISOString(),
          elementSelector: data.elementSelector,
          fullElementSelector: data.fullElementSelector,
          selectedElementHighlightColor: data.selectedElementHighlightColor || undefined,
          domNodeCount,
          fullPageDisabled: isFullPageDisabled(),
          // Parsed system info
          browser: systemInfo.browser,
          os: systemInfo.os,
          devicePixelRatio: systemInfo.devicePixelRatio,
          language: systemInfo.language,
        },
      }),
    });

    modal.remove();

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const minutes = retryAfter ? Math.ceil(parseInt(retryAfter, 10) / 60) : 15;
      showSubmitError(
        root,
        config,
        data,
        `Too many submissions. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
      );
      return;
    }

    const result = await response.json();

    if (result.success) {
      await showSuccessModal(
        root,
        result.issueNumber,
        result.issueUrl,
        result.isPublic ?? false,
        config.issueLinkVisibility
      );
    } else {
      showSubmitError(root, config, data, result.error || 'Failed to submit');
    }
  } catch (_error) {
    modal.remove();
    showSubmitError(root, config, data, 'Network error. Please check your connection.');
  }
}

function showSubmitError(
  root: HTMLElement,
  config: WidgetConfig,
  data: FeedbackData,
  errorMessage: string
) {
  const modal = createModal(
    root,
    'Submission Failed',
    `
      <div class="bd-error-message">
        <svg class="bd-error-message__icon" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0-9.5a.75.75 0 0 0-.75.75v2.5a.75.75 0 0 0 1.5 0v-2.5A.75.75 0 0 0 8 5.5zm0 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>
        </svg>
        <span class="bd-error-message__text">${errorMessage}</span>
      </div>
      <div class="bd-actions">
        <button class="bd-btn bd-btn-secondary" data-action="cancel">Cancel</button>
        <button class="bd-btn bd-btn-primary" data-action="retry">Try Again</button>
      </div>
    `,
    true
  );

  const closeBtn = modal.querySelector('.bd-close') as HTMLElement;
  const cancelBtn = modal.querySelector('[data-action="cancel"]') as HTMLElement;
  const retryBtn = modal.querySelector('[data-action="retry"]') as HTMLElement;

  closeBtn?.addEventListener('click', () => modal.remove());
  cancelBtn?.addEventListener('click', () => modal.remove());

  retryBtn?.addEventListener('click', async () => {
    modal.remove();
    await submitFeedback(root, config, data);
  });
}
