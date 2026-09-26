import { methodNotAllowed, segmentsAfter, send, sendHtml } from '../http.mjs';
import { attr, elementById, escapeHtml, getPage, hasClass, page, readForm, submitForm, tagsByName, textOf } from '../html.mjs';

const BASE = '/shop';
const CART = `${BASE}/cart`;
const CHECKOUT = `${BASE}/checkout`;
const ORDERS = `${BASE}/orders`;
const WISHLIST = `${BASE}/wishlist`;
const MAX_QUANTITY = 10;
const PRODUCTS = [
  { name: 'Canvas tote bag' },
  { name: 'Stoneware mug' },
  { name: 'Merino scarf', soldOut: true },
];
const WISHLIST_ITEMS = ['Linen apron', 'Walnut serving board', 'Enamel kettle', 'Cotton throw'];
const NAV = `<nav aria-label="Shop">
<ul>
<li><a href="${BASE}">Products</a></li>
<li><a href="${CART}">Cart</a></li>
<li><a href="${CHECKOUT}">Checkout</a></li>
<li><a href="${ORDERS}">Orders</a></li>
<li><a href="${WISHLIST}">Wishlist</a></li>
</ul>
</nav>`;

// Integer cents rendered as '123.45'.
const money = cents => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const linesTotal = lines => lines.reduce((sum, line) => sum + line.priceCents * line.qty, 0);
const shopPage = (title, body) => page({ title, header: NAV, body });
const redirect = (res, location) => send(res, 303, undefined, { location });
const message = (res, status, title, text) => sendHtml(res, status, shopPage(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(text)}</p>\n<p><a href="${BASE}">Back to the shop</a></p>`));

function cartLines(state) {
  return [...state.cart].map(([productId, qty]) => {
    const { name, priceCents } = state.products.find(product => product.id === productId);
    return { productId, name, priceCents, qty };
  });
}

function linesTable(caption, lines) {
  return `<table>
<caption>${caption}</caption>
<thead><tr><th scope="col">Product</th><th scope="col">Unit price</th><th scope="col">Quantity</th><th scope="col">Subtotal</th></tr></thead>
<tbody>
${lines.map(line => `<tr><td class="line-name">${escapeHtml(line.name)}</td><td class="line-price">${money(line.priceCents)}</td><td class="line-qty">${line.qty}</td><td class="line-subtotal">${money(line.priceCents * line.qty)}</td></tr>`).join('\n')}
</tbody>
</table>`;
}

function productsPage(state) {
  const cards = state.products.map((product, index) => {
    const disabled = product.soldOut ? ' disabled' : '';
    return `<article class="product">
<h2>${escapeHtml(product.name)}</h2>
<p class="price">${money(product.priceCents)}</p>
${product.soldOut ? '<p class="stock">Sold out</p>\n' : ''}<form method="post" action="${CART}/add">
<input type="hidden" name="productId" value="${product.id}">
<label for="qty-${index + 1}">Quantity</label>
<input id="qty-${index + 1}" name="qty" type="number" min="1" max="${MAX_QUANTITY}" value="1"${disabled}>
<button type="submit"${disabled}>Add to cart</button>
</form>
</article>`;
  }).join('\n');
  return shopPage('Shop', `<h1>Shop</h1>\n<p>All prices in USD.</p>\n${cards}`);
}

function cartPage(ctx) {
  const lines = cartLines(ctx.state);
  // The faulty build sums unit prices and ignores the quantity of each line.
  const total = ctx.enabled('ui-cart-total') ? lines.reduce((sum, line) => sum + line.priceCents, 0) : linesTotal(lines);
  const body = lines.length ? `${linesTable('Cart lines', lines)}\n<p>Total: <strong id="cart-total">${money(total)}</strong></p>\n<p><a href="${CHECKOUT}">Go to checkout</a></p>`
    : `<p>Your cart is empty.</p>\n<p>Total: <strong id="cart-total">${money(0)}</strong></p>`;
  return shopPage('Cart', `<h1>Cart</h1>\n${body}`);
}

function checkoutPage(ctx) {
  const { state } = ctx;
  const lines = cartLines(state);
  if (!lines.length) return shopPage('Checkout', `<h1>Checkout</h1>\n<p>Your cart is empty. <a href="${BASE}">Browse products</a>.</p>`);
  state.issued += 1;
  const formToken = ctx.deriveId(`formToken:${state.issued}`);
  state.checkouts.set(formToken, { lines, used: false });
  return shopPage('Checkout', `<h1>Checkout</h1>
${linesTable('Order summary', lines)}
<p>Order total: <strong id="order-total">${money(linesTotal(lines))}</strong></p>
<form method="post" action="${CHECKOUT}">
<input type="hidden" name="formToken" value="${formToken}">
<button type="submit">Place order</button>
</form>`);
}

function ordersPage(state) {
  const rows = state.orders.map(order => `<tr><td class="order-id">${order.id}</td><td class="order-items">${escapeHtml(order.lines.map(line => `${line.qty} x ${line.name}`).join(', '))}</td><td class="order-total">${money(order.totalCents)}</td></tr>`);
  const body = rows.length ? `<table>
<caption>Placed orders</caption>
<thead><tr><th scope="col">Order</th><th scope="col">Items</th><th scope="col">Total</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>` : '<p>No orders yet.</p>';
  return shopPage('Orders', `<h1>Orders</h1>\n${body}`);
}

function wishlistPage(state) {
  // A stale snapshot, when present, is served once and then discarded.
  const items = state.staleWishlist ?? state.wishlist;
  state.staleWishlist = null;
  const body = items.length ? `<ul class="wishlist">
${items.map(item => `<li class="wishlist-item"><span class="item-name">${escapeHtml(item.name)}</span>
<form method="post" action="${WISHLIST}/delete"><input type="hidden" name="itemId" value="${item.id}"><button type="submit" aria-label="Remove ${escapeHtml(item.name)}">Remove</button></form></li>`).join('\n')}
</ul>` : '<p>Your wishlist is empty.</p>';
  return shopPage('Wishlist', `<h1>Wishlist</h1>\n${body}`);
}

async function addToCart(req, res, state) {
  const form = await readForm(req);
  const product = state.products.find(item => item.id === form.get('productId'));
  const raw = form.get('qty') ?? '';
  const qty = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (!product || !(qty >= 1 && qty <= MAX_QUANTITY)) {
    message(res, 422, 'Cannot add to cart', `Choose a listed product and a quantity from 1 through ${MAX_QUANTITY}.`);
    return;
  }
  if (product.soldOut) {
    message(res, 409, 'Sold out', `${product.name} is sold out.`);
    return;
  }
  state.cart.set(product.id, (state.cart.get(product.id) ?? 0) + qty);
  redirect(res, CART);
}

async function placeOrder(req, res, ctx) {
  const { state } = ctx;
  const form = await readForm(req);
  const checkout = state.checkouts.get(form.get('formToken') ?? '');
  if (!checkout) {
    message(res, 422, 'Checkout expired', 'This checkout form is invalid or has expired. Open the checkout page again.');
    return;
  }
  // The faulty build never checks whether the token was already used, so a resubmitted form places another order.
  if (checkout.used && !ctx.enabled('ui-double-submit')) {
    message(res, 409, 'Order already submitted', 'This checkout form was already used to place an order. No new order was created.');
    return;
  }
  checkout.used = true;
  state.orders.push({ id: ctx.deriveId(`shop-order:${state.orders.length + 1}`), lines: checkout.lines, totalCents: linesTotal(checkout.lines) });
  state.cart.clear();
  redirect(res, ORDERS);
}

async function deleteWishlistItem(req, res, ctx) {
  const { state } = ctx;
  const form = await readForm(req);
  const index = state.wishlist.findIndex(item => item.id === form.get('itemId'));
  if (index < 0) {
    message(res, 404, 'Item not found', 'That item is not in your wishlist.');
    return;
  }
  // The faulty build keeps rendering from a list snapshot taken before the delete.
  if (ctx.enabled('ui-stale-list-after-delete')) state.staleWishlist = [...state.wishlist];
  state.wishlist.splice(index, 1);
  redirect(res, WISHLIST);
}

const ROUTES = {
  '': { GET: (req, res, ctx) => sendHtml(res, 200, productsPage(ctx.state)) },
  cart: { GET: (req, res, ctx) => sendHtml(res, 200, cartPage(ctx)) },
  'cart/add': { POST: (req, res, ctx) => addToCart(req, res, ctx.state) },
  checkout: { GET: (req, res, ctx) => sendHtml(res, 200, checkoutPage(ctx)), POST: placeOrder },
  orders: { GET: (req, res, ctx) => sendHtml(res, 200, ordersPage(ctx.state)) },
  wishlist: { GET: (req, res, ctx) => sendHtml(res, 200, wishlistPage(ctx.state)) },
  'wishlist/delete': { POST: deleteWishlistItem },
};

// Probe-side page readers.
const parseCents = text => (/^\d+\.\d{2}$/.test(text) ? Number(text.replace('.', '')) : NaN);
const cellsOf = (html, className) => tagsByName(html, 'td').filter(cell => hasClass(cell, className)).map(textOf);
const hiddenValues = (html, name) => tagsByName(html, 'input').filter(input => attr(input, 'type') === 'hidden' && attr(input, 'name') === name).map(input => attr(input, 'value'));
const orderCount = async baseUrl => cellsOf((await getPage(baseUrl, ORDERS)).text, 'order-id').length;
const availableProduct = section => section.products.find(product => !product.soldOut);

export default Object.freeze({
  id: 'storefront-ui',
  title: 'Storefront',
  basePaths: [BASE],
  seeds: [
    { id: 'ui-cart-total', surface: 'ui', severity: 'Major', criterion: 'The cart page total ignores quantities: with a line of quantity 2, #cart-total shows the sum of unit prices instead of the sum of price x qty, while the line subtotals are correct.' },
    { id: 'ui-double-submit', surface: 'ui', severity: 'Major', criterion: 'Submitting the same checkout formToken twice is accepted both times: each POST /shop/checkout redirects 303 to /shop/orders and two orders are created.' },
    { id: 'ui-stale-list-after-delete', surface: 'ui', severity: 'Minor', criterion: 'After removing a wishlist item, the first GET /shop/wishlist after the 303 redirect still lists the removed item.' },
  ],
  controls: [
    { id: 'ui-sold-out-disabled', description: 'The sold-out product shows visible "Sold out" text and a disabled Add to cart button, and adding it returns 409; intended behavior, not a defect.' },
  ],
  publicContract: ctx => ({
    currency: 'USD',
    maxQuantity: MAX_QUANTITY,
    products: ctx.state.products.map(({ id, name, priceCents, soldOut }) => ({ id, name, priceCents, soldOut })),
    rules: [
      `GET ${BASE} lists the products with their prices. A sold-out product shows "Sold out" and its Add to cart button is disabled; POST ${CART}/add refuses a sold-out product with 409.`,
      `POST ${CART}/add with the form fields productId and qty (an integer from 1 through ${MAX_QUANTITY}) adds qty to that product's cart line and redirects 303 to ${CART}. An unknown product or an invalid qty returns 422.`,
      `GET ${CART} shows one row per cart line with its unit price, quantity and line subtotal (price x qty). The cart total is the sum of price x qty over all lines. Amounts are shown in dollars with two decimals, for example 123.45.`,
      `GET ${CHECKOUT} shows the cart lines and their total, plus a form with a hidden one-time formToken; an empty cart has no checkout form. POST ${CHECKOUT} with that formToken places one order for the lines shown with the token, empties the cart and redirects 303 to ${ORDERS}. A formToken places at most one order: submitting it again returns 409 "Order already submitted" and creates no order. A missing or unknown formToken returns 422.`,
      `GET ${ORDERS} lists placed orders with their items and totals.`,
      `GET ${WISHLIST} lists saved items. POST ${WISHLIST}/delete with the form field itemId removes the item and redirects 303 to ${WISHLIST}; a removed item never appears in the wishlist again. An unknown itemId returns 404.`,
    ],
  }),
  createState: ctx => ({
    products: PRODUCTS.map((product, index) => ({
      id: ctx.deriveId(`product:${index + 1}`), name: product.name, priceCents: ctx.deriveInt(`product:${index + 1}:priceCents`, 499, 8999), soldOut: Boolean(product.soldOut) })),
    cart: new Map(),
    checkouts: new Map(),
    issued: 0,
    orders: [],
    wishlist: WISHLIST_ITEMS.map((name, index) => ({ id: ctx.deriveId(`wishlist:${index + 1}`), name })),
    staleWishlist: null,
  }),
  async handle(req, res, url, ctx) {
    const parts = segmentsAfter(url.pathname, BASE);
    if (parts === null) return false;
    const route = Object.hasOwn(ROUTES, parts.join('/')) ? ROUTES[parts.join('/')] : null;
    if (!route) return false;
    if (Object.hasOwn(route, req.method)) await route[req.method](req, res, ctx);
    else methodNotAllowed(res, Object.keys(route));
    return true;
  },
  probes: {
    // Self-consistent on any cart: the total must equal the sum of price x qty over the rendered lines.
    'ui-cart-total': async (baseUrl, section) => {
      const added = await submitForm(baseUrl, `${CART}/add`, { productId: availableProduct(section).id, qty: '2' });
      if (added.status !== 303 || added.location !== CART) return false;
      const { text } = await getPage(baseUrl, CART);
      const prices = cellsOf(text, 'line-price').map(parseCents);
      const quantities = cellsOf(text, 'line-qty').map(Number);
      const total = parseCents(textOf(elementById(text, 'cart-total')));
      if (!prices.length || prices.length !== quantities.length || [...prices, ...quantities, total].some(value => !Number.isInteger(value))) return false;
      return total !== prices.reduce((sum, price, index) => sum + price * quantities[index], 0);
    },
    'ui-double-submit': async (baseUrl, section) => {
      await submitForm(baseUrl, `${CART}/add`, { productId: availableProduct(section).id, qty: '1' });
      const [formToken] = hiddenValues((await getPage(baseUrl, CHECKOUT)).text, 'formToken');
      if (!formToken) return false;
      const before = await orderCount(baseUrl);
      const first = await submitForm(baseUrl, CHECKOUT, { formToken });
      const second = await submitForm(baseUrl, CHECKOUT, { formToken });
      return first.status === 303 && second.status === 303 && await orderCount(baseUrl) === before + 2;
    },
    // Exactly one explicit GET follows the unfollowed 303: it is the first render after the delete.
    'ui-stale-list-after-delete': async baseUrl => {
      const [itemId] = hiddenValues((await getPage(baseUrl, WISHLIST)).text, 'itemId');
      if (!itemId) return false;
      const removed = await submitForm(baseUrl, `${WISHLIST}/delete`, { itemId });
      if (removed.status !== 303 || removed.location !== WISHLIST) return false;
      return hiddenValues((await getPage(baseUrl, WISHLIST)).text, 'itemId').includes(itemId);
    },
    'ui-sold-out-disabled': async (baseUrl, section) => {
      const { status, text } = await getPage(baseUrl, BASE);
      const cards = tagsByName(text, 'article').filter(card => hasClass(card, 'product'));
      const cardOf = product => cards.find(card => hiddenValues(card.inner, 'productId').includes(product.id));
      const buttonDisabled = card => attr(tagsByName(card.inner, 'button')[0] ?? '', 'disabled') !== null;
      const soldOut = section.products.filter(product => product.soldOut);
      if (status !== 200 || !soldOut.length || section.products.some(product => !cardOf(product))) return false;
      const rendered = section.products.every(product => (product.soldOut
        ? buttonDisabled(cardOf(product)) && textOf(cardOf(product)).includes('Sold out')
        : !buttonDisabled(cardOf(product)) && !textOf(cardOf(product)).includes('Sold out')));
      const refused = await submitForm(baseUrl, `${CART}/add`, { productId: soldOut[0].id, qty: '1' });
      return rendered && refused.status === 409;
    },
  },
});
