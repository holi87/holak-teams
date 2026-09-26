import { methodNotAllowed, segmentsAfter, send, sendHtml } from '../http.mjs';
import { attr, elementById, escapeHtml, getPage, hasClass, page, readForm, submitForm, tagsByName, textOf } from '../html.mjs';

const BASE = '/account';
const SIGNUP = `${BASE}/signup`;
const SETTINGS = `${BASE}/settings`;
const DELETE = `${SETTINGS}/delete`;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
const TEXT_COLOR = '#1a1a1a';
const BACKGROUND = '#ffffff';
const ERROR_COLOR = '#b00020';
const LOW_CONTRAST_ERROR_COLOR = '#a0a0a0';
const MIN_TEXT_CONTRAST = 4.5;
const svgUri = svg => `data:image/svg+xml,${encodeURIComponent(svg)}`;
const LOGO = svgUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="#2b5fad"/><path d="M14 26l7 7 13-16" fill="none" stroke="#ffffff" stroke-width="4"/></svg>');
const TRASH = svgUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7z" fill="#1a1a1a"/></svg>');
const STYLE = `<style>
body{font-family:system-ui,sans-serif;color:${TEXT_COLOR};background-color:${BACKGROUND};line-height:1.5;max-width:40rem;margin:0 auto;padding:1rem}
.page-heading{display:flex;align-items:center;gap:.75rem}
.field{margin:1rem 0}
.field label{display:block;font-weight:600}
.error-summary{border:3px solid ${ERROR_COLOR};padding:0 1rem;margin:1rem 0}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.icon-trash{width:2.75rem;height:2.75rem;border:1px solid #767676;border-radius:.25rem;background:${BACKGROUND} url("${TRASH}") center/1.5rem no-repeat;cursor:pointer}
</style>`;
const SETTING_SECTIONS = [
  { heading: 'Profile', text: 'Your display name and email address are managed by your organization.' },
  { heading: 'Notifications', text: 'Email notifications are sent for security events only.' },
];

function accountPage(title, body) {
  return page({ title, head: STYLE, header: `<nav aria-label="Account"><a href="${SIGNUP}">Sign up</a> | <a href="${SETTINGS}">Settings</a></nav>`, body });
}

function signupPage(ctx, { email = '', errors = {} } = {}) {
  const invalid = Object.keys(errors);
  const announced = !ctx.enabled('a11y-error-not-announced');
  const errorColor = ctx.enabled('a11y-error-contrast') ? LOW_CONTRAST_ERROR_COLOR : ERROR_COLOR;
  // The faulty builds drop the announcement and field association, or render the inline error in light grey.
  const summary = invalid.length ? `<div class="error-summary"${announced ? ' role="alert"' : ''}>
<h2>There is a problem</h2>
<ul>
${invalid.map(name => `<li><a href="#${name}">${escapeHtml(errors[name])}</a></li>`).join('\n')}
</ul>
</div>\n` : '';
  const field = ({ name, label, type, autocomplete, placeholder, value }) => {
    const error = errors[name];
    // The faulty build relies on the placeholder alone to identify the email field.
    const unlabelled = name === 'email' && ctx.enabled('a11y-missing-label');
    const hint = unlabelled ? 'Email address' : placeholder;
    const association = error && announced ? ` aria-invalid="true" aria-describedby="${name}-error"` : '';
    return `<div class="field">
${unlabelled ? '' : `<label for="${name}">${label}</label>\n`}${error ? `<p id="${name}-error" class="field-error" style="color:${errorColor};background-color:${BACKGROUND}">Error: ${escapeHtml(error)}</p>\n` : ''}<input id="${name}" name="${name}" type="${type}" autocomplete="${autocomplete}"${hint ? ` placeholder="${hint}"` : ''}${value === undefined ? '' : ` value="${escapeHtml(value)}"`}${association}>
</div>`;
  };
  return accountPage(invalid.length ? 'Error: Create an account' : 'Create an account', `<div class="page-heading">
<img src="${LOGO}" alt="" role="presentation" width="48" height="48">
<h1>Create an account</h1>
</div>
${summary}<form method="post" action="${SIGNUP}" novalidate>
${field({ name: 'email', label: 'Email address', type: 'email', autocomplete: 'email', placeholder: 'name@example.com', value: email })}
${field({ name: 'password', label: `Password (${MIN_PASSWORD} to ${MAX_PASSWORD} characters)`, type: 'password', autocomplete: 'new-password' })}
<button type="submit">Create account</button>
</form>
<p>Already registered? <a href="${SETTINGS}">Go to account settings</a>.</p>`);
}

function settingsPage(ctx, query) {
  const needle = query.trim().toLowerCase();
  const sections = [...SETTING_SECTIONS.map(({ heading, text }) => ({ heading, html: `<p>${text}</p>` })), {
    heading: 'Delete account',
    // The faulty build ships the icon-only button without an accessible name.
    html: `<p>Deleting your account removes your profile and cannot be undone.</p>
<form method="post" action="${DELETE}">
<button type="submit" class="icon-trash"${ctx.enabled('a11y-icon-button-name') ? '' : ' aria-label="Delete account"'}></button>
</form>`,
  }].filter(section => !needle || section.heading.toLowerCase().includes(needle));
  const results = needle ? `<p>${sections.length ? `Settings matching "${escapeHtml(query.trim())}":` : `No settings match "${escapeHtml(query.trim())}".`}</p>\n` : '';
  return accountPage('Account settings', `<div class="page-heading">
<h1>Account settings</h1>
</div>
<form role="search" method="get" action="${SETTINGS}">
<label for="settings-search" class="visually-hidden">Search settings</label>
<input id="settings-search" name="q" type="search" value="${escapeHtml(query)}">
<button type="submit">Search</button>
</form>
${results}${sections.map(section => `<section>\n<h2>${section.heading}</h2>\n${section.html}\n</section>`).join('\n')}`);
}

async function signup(req, res, ctx) {
  const form = await readForm(req);
  const email = (form.get('email') ?? '').trim();
  const password = form.get('password') ?? '';
  const errors = {};
  if (email.length > 254 || !EMAIL.test(email)) errors.email = 'Enter a valid email address, like name@example.com';
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) errors.password = `Enter a password of ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`;
  if (Object.keys(errors).length) sendHtml(res, 200, signupPage(ctx, { email, errors }));
  else send(res, 303, undefined, { location: SETTINGS });
}

async function deleteAccount(req, res) {
  const form = await readForm(req);
  if (form.get('confirm') === 'yes') {
    sendHtml(res, 200, accountPage('Account deletion requested', `<h1>Account deletion requested</h1>
<p>Your request to delete this account was received.</p>
<p><a href="${SETTINGS}">Back to account settings</a></p>`));
    return;
  }
  sendHtml(res, 200, accountPage('Delete your account?', `<h1>Delete your account?</h1>
<p>Deleting your account removes your profile and cannot be undone.</p>
<form method="post" action="${DELETE}">
<input type="hidden" name="confirm" value="yes">
<button type="submit">Delete account</button>
</form>
<p><a href="${SETTINGS}">Cancel and keep my account</a></p>`));
}

// WCAG 2.2 relative luminance and contrast ratio of two #rrggbb colors.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(offset => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(foreground, background) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}
function inlineColors(element) {
  const style = attr(element, 'style') ?? '';
  const color = /(?:^|;)\s*color\s*:\s*(#[0-9a-f]{6})\b/i.exec(style)?.[1];
  const background = /(?:^|;)\s*background-color\s*:\s*(#[0-9a-f]{6})\b/i.exec(style)?.[1] ?? BACKGROUND;
  return color ? { color, background } : null;
}

// Text of every element referenced by an id-list attribute such as aria-labelledby.
const referencedText = (html, ids) => (ids ?? '').split(/\s+/).filter(Boolean).map(id => textOf(elementById(html, id))).join(' ').trim();

// A programmatic label: aria-label, aria-labelledby, or a label[for] with text. Placeholders do not count.
function hasProgrammaticLabel(html, input) {
  if ((attr(input, 'aria-label') ?? '').trim() || referencedText(html, attr(input, 'aria-labelledby'))) return true;
  const id = attr(input, 'id');
  return Boolean(id) && tagsByName(html, 'label').some(label => attr(label, 'for') === id && textOf(label));
}

const accessibleButtonName = (html, button) => (attr(button, 'aria-label') ?? '').trim() || referencedText(html, attr(button, 'aria-labelledby'))
  || textOf(button) || (attr(button, 'title') ?? '').trim();

const formInputs = html => tagsByName(html, 'input').filter(input => !['hidden', 'submit', 'button'].includes(attr(input, 'type')));
const invalidSignup = baseUrl => submitForm(baseUrl, SIGNUP, { email: 'not-an-email', password: 'long-enough-password' });

export default Object.freeze({
  id: 'a11y-forms',
  title: 'Account forms',
  basePaths: [BASE],
  entryPaths: [SIGNUP, SETTINGS],
  seeds: [
    { id: 'a11y-missing-label', surface: 'a11y', severity: 'Major', criterion: 'The email input on /account/signup has only a placeholder: no label[for], aria-label or aria-labelledby gives it a programmatic label (WCAG 1.3.1 and 4.1.2).' },
    { id: 'a11y-icon-button-name', surface: 'a11y', severity: 'Major', criterion: 'The icon-only delete-account button on /account/settings has no accessible name: no text, aria-label, aria-labelledby or title (WCAG 4.1.2).' },
    { id: 'a11y-error-contrast', surface: 'a11y', severity: 'Major', criterion: 'The inline signup error text is #a0a0a0 on #ffffff, a contrast ratio of about 2.6:1, below the 4.5:1 minimum for text (WCAG 1.4.3).' },
    { id: 'a11y-error-not-announced', surface: 'a11y', severity: 'Major', criterion: 'Signup validation errors are neither announced nor tied to the field: the error summary has no role="alert" or aria-live, and the invalid email input has no aria-invalid or aria-describedby (WCAG 3.3.1 and 4.1.3).' },
  ],
  controls: [
    { id: 'a11y-decorative-image', description: 'The decorative image beside the visible signup heading has alt="" and role="presentation"; an empty text alternative is correct for decoration.' },
    { id: 'a11y-visually-hidden-label', description: 'The settings search input is labelled by a visually hidden label[for]; the label stays exposed to assistive technology, so the input is correctly labelled.' },
  ],
  publicContract: () => ({
    accessibilityStandard: { version: 'WCAG 2.2', level: 'AA' },
    pages: [SIGNUP, SETTINGS],
    rules: [
      `GET ${SIGNUP} shows the sign-up form with email and password fields. POST ${SIGNUP} (form fields email and password) with a valid email address and a password of ${MIN_PASSWORD} to ${MAX_PASSWORD} characters redirects 303 to ${SETTINGS}; otherwise it returns 200 with the form, an error summary and an inline error for each invalid field.`,
      `GET ${SETTINGS} shows the account settings with a settings search (the q query parameter filters sections by heading) and an icon-only delete-account button. POST ${DELETE} asks for confirmation; posting the confirmation form (confirm=yes) records the deletion request.`,
      'These pages conform to WCAG 2.2 level AA. Every form input has a programmatic label (a label[for], aria-label or aria-labelledby; a placeholder is not a label), and every icon-only button has an accessible name.',
      `Text, including inline error text, has a contrast ratio of at least ${MIN_TEXT_CONTRAST}:1 against its background.`,
      'Validation errors are announced: the error summary uses role="alert" (or aria-live="assertive"), and each invalid input has aria-invalid="true" and aria-describedby pointing at its inline error.',
      'Purely decorative images use an empty alt attribute. Visually hidden labels (the visually-hidden class) are a supported labelling technique.',
    ],
  }),
  createState: () => ({}),
  async handle(req, res, url, ctx) {
    const parts = segmentsAfter(url.pathname, BASE);
    if (parts === null) return false;
    const path = `${BASE}/${parts.join('/')}`;
    if (path === SIGNUP) {
      if (req.method === 'GET') sendHtml(res, 200, signupPage(ctx));
      else if (req.method === 'POST') await signup(req, res, ctx);
      else methodNotAllowed(res, ['GET', 'POST']);
      return true;
    }
    if (path === SETTINGS) {
      if (req.method === 'GET') sendHtml(res, 200, settingsPage(ctx, (url.searchParams.get('q') ?? '').slice(0, 100)));
      else methodNotAllowed(res, ['GET']);
      return true;
    }
    if (path === DELETE) {
      if (req.method === 'POST') await deleteAccount(req, res);
      else methodNotAllowed(res, ['POST']);
      return true;
    }
    return false;
  },
  probes: {
    'a11y-missing-label': async baseUrl => {
      const { status, text } = await getPage(baseUrl, SIGNUP);
      const inputs = formInputs(text);
      return status === 200 && inputs.length > 0 && inputs.some(input => !hasProgrammaticLabel(text, input));
    },
    'a11y-icon-button-name': async baseUrl => {
      const { status, text } = await getPage(baseUrl, SETTINGS);
      const buttons = tagsByName(text, 'button');
      return status === 200 && buttons.length > 0 && buttons.some(button => !accessibleButtonName(text, button));
    },
    'a11y-error-contrast': async baseUrl => {
      const { status, text } = await invalidSignup(baseUrl);
      const errors = tagsByName(text, 'p').filter(element => hasClass(element, 'field-error')).map(inlineColors).filter(Boolean);
      return status === 200 && errors.some(({ color, background }) => contrastRatio(color, background) < MIN_TEXT_CONTRAST);
    },
    'a11y-error-not-announced': async baseUrl => {
      const { status, text } = await invalidSignup(baseUrl);
      if (status !== 200) return false;
      const summary = tagsByName(text, 'div').find(element => hasClass(element, 'error-summary'));
      const email = tagsByName(text, 'input').find(input => attr(input, 'name') === 'email');
      if (!summary || !email) return false;
      const announced = attr(summary, 'role') === 'alert' || attr(summary, 'aria-live') === 'assertive';
      const described = referencedText(text, attr(email, 'aria-describedby'));
      const tied = attr(email, 'aria-invalid') === 'true' && described.includes('valid email');
      return !announced || !tied;
    },
    'a11y-decorative-image': async baseUrl => {
      const { status, text } = await getPage(baseUrl, SIGNUP);
      const images = tagsByName(text, 'img');
      const decorative = images.filter(image => attr(image, 'alt') === '' && ['presentation', 'none'].includes(attr(image, 'role')));
      const heading = tagsByName(text, 'h1').map(textOf).find(Boolean);
      return status === 200 && decorative.length > 0 && images.every(image => attr(image, 'alt') !== null) && Boolean(heading);
    },
    'a11y-visually-hidden-label': async baseUrl => {
      const { status, text } = await getPage(baseUrl, SETTINGS);
      const search = tagsByName(text, 'input').find(input => attr(input, 'type') === 'search');
      const label = search && tagsByName(text, 'label').find(element => attr(element, 'for') === attr(search, 'id'));
      const rule = /\.visually-hidden\s*\{([^}]*)\}/.exec(tagsByName(text, 'style').map(style => style.inner).join('\n'))?.[1] ?? '';
      const exposed = /\bclip(?:-path)?\s*:/.test(rule) && !/display\s*:\s*none|visibility\s*:\s*hidden/.test(rule);
      return status === 200 && Boolean(label) && Boolean(textOf(label)) && hasClass(label, 'visually-hidden') && exposed;
    },
  },
});
