// ==UserScript==
// @name         AliExpress Filter
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  Hide low-rated, unrated, low-seller-score, low-votes and promo items on AliExpress
// @match        *://*.aliexpress.com/*
// @grant        none
// @license      MIT
// @homepageURL  https://github.com/anrinion/aliexpress-filter
// ==/UserScript==

(function () {
    'use strict';

    const MIN_SELLER_SCORE = 80;
    const PROMO_KEYWORDS = ['Combo Blast', 'Bundle Deal', 'Combo Deals', 'Super Deals'];

    // Selectors for cleaning up garbage elements
    const GARBAGE_SELECTORS = [
        // Discount badges and percentages
        '.kt_lj', // -50% discount badges

        // Extra offers and promotional text
        '.kt_lr', // "Top selling on AliExpress" etc
        '.kt_lq', // Free shipping badges
        '.mr_a1.mr_mt', // Free shipping text

        // Sale images - specifically target the ones you mentioned
        '.mr_mu', // Sale/promo images before product names
        'img[src*="Sale"]', // Images with "Sale" in the URL
        'img[src*="sale"]', // Images with "sale" in the URL (case insensitive)
        'img[src*="promo"]', // Promo images
        'img[src*="discount"]', // Discount images
        'img[height="16"]', // Small promotional images (common size for sale badges)

        // Any element with line-through (crossed prices)
        '[style*="line-through"]',

        // Generic promo/badge selectors (be careful with these)
        '[class*="promo"]',
        '[class*="badge"][class*="discount"]'
    ];

    // Sale-event banners (11.11 etc.) and title chips, hidden via injected CSS rather than inline styles:
    // they render late / get re-rendered, which the one-shot per-card cleanup misses.
    // Class names are hashed, so match by stable fragment.
    const CSS_GARBAGE_SELECTORS = [
        '[class*="--sale"][class*="Carousel--"]', // red "11.11 Sale · Ends: Nov 18" bar above results
        '[class*="--titleIcon--"]',               // "Choice", "SuperDeals" etc. chips before the title
        // Narrow-window list layout:
        '[class*="pricePointLineOne--"] > img',   // 11.11 / Choice chips (row also hosts AliHelper's badge)
        '[class*="pricePointLineTwo--"]',         // red "Sale · -15% now", "Early bird deal", "Extra 1% off with coins"
        '[class*="--memoTips"]',                  // "Ads may influence search results ranking. Learn here how..."
        '.ah-ref-label',                          // AliHelper's "Партнерская ссылка" (injected after our per-card pass)
    ];

    // Upsell chips that share markup with useful ones ("Great price in last month", "Free shipping"),
    // so they're matched by text. AliExpress reuses card nodes across pages, so these are re-checked on
    // every pass and marked with a class (not an inline style) that's dropped when the text changes.
    const TEXT_GARBAGE_CONTAINERS = '[class*="--priceBottomItem--"], [class*="--serviceItem--"]';
    const TEXT_GARBAGE_PATTERNS = [
        // "Extra 2% off with coins"
        /off with coins/i, /mit Münzen/i, /avec les pièces/i, /con monedas/i, /z monetami/i, /^Jetonlarla ekstra/i,
        /скидка за монеты/i, /з монетами/i, /مع العملات/,
        // "Top selling on AliExpress"
        /^Top selling on AliExpress$/i, /^Auf AliExpress meistverkauft$/i, /^Le plus vendu sur AliExpress$/i,
        /^Top ventas en AliExpress$/i, /^Bestseller AliExpress$/i, /^AliExpress'te en çok satanlar$/i,
        /^Хит продаж на AliExpress$/i, /^Лідер продажів на AliExpress$/i, /^الأفضل مبيعاً في AliExpress$/,
    ];

    // Additional cleanup for sale images by URL patterns
    const SALE_IMAGE_PATTERNS = [
        /sale/i,
        /discount/i,
        /promo/i,
        /badge/i,
        /154x64\.png/i,
    ];

    const defaultConfig = {
        minRating: 4.7,
        minVotes: 10,
        filterEnabled: true,
        cleanupEnabled: true,
        debugEnabled: false
    };

    const config = loadConfig();
    let lastUrl = location.href;
    // card -> product it was cleaned for. AliExpress reuses card nodes when paginating,
    // so a card is re-cleaned when it starts showing a different product.
    const cleanedFor = new WeakMap();

    function loadConfig() {
        const stored = JSON.parse(localStorage.getItem('aeFilterConfig') || '{}');
        return { ...defaultConfig, ...stored };
    }

    function saveConfig() {
        localStorage.setItem('aeFilterConfig', JSON.stringify(config));
        hideLowRatedAndPromoItems();
    }

    function log(message) {
        if (config.debugEnabled) {
            console.log(message);
        }
    }

    // Rating like "4.8", or "4,8" in languages with a decimal comma
    function parseNumber(text) {
        const match = text.trim().match(/^([0-5](?:[.,]\d)?)$/);
        return match ? parseFloat(match[1].replace(',', '.')) : null;
    }

    function calculateRatingError(rating, votes) {
        if (votes <= 0) return null;
        if (votes < 5) return 1.0;

        const p = rating / 5;
        const n = votes;
        const z = 3.29;

        const denominator = 1 + (z * z) / n;
        const centre = p + (z * z) / (2 * n);
        const adjustment = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);

        const lowerBound = (centre - adjustment) / denominator;
        const upperBound = (centre + adjustment) / denominator;

        const lowerRating = lowerBound * 5;
        const upperRating = upperBound * 5;

        const error = (upperRating - lowerRating) / 2;
        return Math.round(error * 100) / 100;
    }

    // The sold count in each site language: "29 sold", "1K+ sold", "+3 Tsd. verkauft",
    // "+ 3 K vendus", "3K+ vendidos", "+3 tys. sprzedano", "+3 bin satıldı", "+3 тыс. продано",
    // "100 000+ продано", "+3 ألف مباعة"
    const SOLD_WORDS = /(^|[^\p{L}])(sold|verkauft|vendus?|vendid[oa]s?|sprzedan[oey]?|satıldı|продано|مباعة)([^\p{L}]|$)/iu;
    // Thousands/millions suffixes after the number: "3K+", "3 Tsd.", "3 tys.", "3 mil"
    const SOLD_MULTIPLIERS = { k: 1e3, tsd: 1e3, tys: 1e3, 'тыс': 1e3, 'тис': 1e3, 'ألف': 1e3, mil: 1e3, bin: 1e3, b: 1e3, m: 1e6, mio: 1e6, 'млн': 1e6, 'مليون': 1e6 };
    const SOLD_COUNT = new RegExp(
        String.raw`(\d[\d.,\s]*?)\s*(?:(${Object.keys(SOLD_MULTIPLIERS).sort((a, b) => b.length - a.length).join('|')})(?!\p{L}))?\.?\s*\+?\s*\p{L}`,
        'iu');

    function parseVotesCount(text) {
        if (!SOLD_WORDS.test(text)) return null;
        const match = text.match(SOLD_COUNT);
        if (!match) return null;
        const [, number, suffix] = match;
        if (!suffix) return parseInt(number.replace(/[.,\s]/g, '')); // "1,000+ sold" -> 1000
        const value = parseFloat(number.replace(/\s/g, '').replace(',', '.')); // "1,5 Tsd." -> 1.5
        return Math.round(value * SOLD_MULTIPLIERS[suffix.toLowerCase()]);
    }

    function extractVotesNearRating(card, ratingSpan) {
        const context = ratingSpan.closest('div')?.parentElement;
        if (!context) return 0;

        // Leaf elements only: a container's text would glue the rating onto the count ("4.929 sold")
        for (const el of context.querySelectorAll('*')) {
            if (el.children.length) continue;
            const votes = parseVotesCount(el.textContent.trim());
            if (votes) return votes;
        }

        return 0;
    }

    function findRatingInCard(card) {
        let ratingSpan = card.querySelector('span[class*="review_Star_"]');
        if (ratingSpan) return ratingSpan;

        const allDivs = [...card.querySelectorAll('div')].reverse(); // deepest first

        for (let div of allDivs) {
            const span = [...div.querySelectorAll('span')].find(
                s => parseNumber(s.textContent) !== null
            );
            const stars = div.querySelectorAll('img[width="12"], img[style*="width: 12px"]');

            if (span && stars.length >= 1) {
                ratingSpan = span;
                break;
            }
        }

        // Narrow-window list layout: rating is span.starRating--* (e.g. "4")
        return ratingSpan || card.querySelector('span[class*="starRating--"]') || null;
    }

    // Shows "±0.03" after the rating. Re-evaluated on every pass: AliExpress reuses card nodes
    // when paginating, so a span added for the previous product must be updated or removed.
    function updateRatingError(card) {
        const ratingSpan = findRatingInCard(card);
        const rating = ratingSpan ? parseNumber(ratingSpan.textContent) : null;
        const votes = rating ? extractVotesNearRating(card, ratingSpan) : 0;
        const error = votes > 0 ? calculateRatingError(rating, votes) : null;

        const next = ratingSpan?.nextSibling;
        let errorSpan = next?.classList?.contains('ae-rating-error') ? next : null;
        card.querySelectorAll('.ae-rating-error').forEach(s => { if (s !== errorSpan) s.remove(); });

        if (error === null) {
            errorSpan?.remove();
            return;
        }
        if (!errorSpan) {
            errorSpan = document.createElement('span');
            errorSpan.className = 'ae-rating-error';
            errorSpan.style.fontSize = '1em';
            errorSpan.style.color = '#666';
            errorSpan.style.marginLeft = '2px';
            ratingSpan.parentNode.insertBefore(errorSpan, ratingSpan.nextSibling);
        }
        const text = `±${error}`;
        if (errorSpan.textContent !== text) errorSpan.textContent = text; // no-op writes would retrigger the observer
    }

    function markTextGarbage(card) {
        card.querySelectorAll(TEXT_GARBAGE_CONTAINERS).forEach(el => {
            const text = el.textContent.trim();
            const garbage = TEXT_GARBAGE_PATTERNS.some(p => p.test(text));
            if (el.classList.contains('ae-garbage') !== garbage) el.classList.toggle('ae-garbage', garbage);
        });
    }

    function productKey(card) {
        return card.querySelector('a[href]')?.getAttribute('href') || card.textContent.slice(0, 200);
    }

    // Legacy per-card cleanup (selectors from older AliExpress markup). Elements are marked with
    // .ae-hidden, which the injected CSS hides only while Cleanup is on.
    function cleanCard(card) {
        const key = productKey(card);
        if (cleanedFor.get(card) === key) return;
        cleanedFor.set(card, key);

        // Reused card now showing another product: undo what we hid for the previous one
        card.querySelectorAll('.ae-hidden').forEach(el => el.classList.remove('ae-hidden'));
        const hide = (el, why) => {
            el.classList.add('ae-hidden');
            log(`[Clean] Hidden ${why}: "${el.textContent.trim().substring(0, 30)}"`);
        };

        // Remove elements by selector
        GARBAGE_SELECTORS.forEach(sel => {
            card.querySelectorAll(sel).forEach(el => {
                // Don't hide if it contains important info
                const text = el.textContent.trim();
                const isImportant = parseNumber(text) !== null || // rating like "4.7"
                                  parseVotesCount(text) !== null || // sold count
                                  /^[\d,]+\.?\d*[€$¥£₽]/.test(text); // main price
                if (!isImportant) hide(el, `by selector "${sel}"`);
            });
        });

        // Specifically target sale images by URL pattern
        card.querySelectorAll('img').forEach(img => {
            const src = img.src || '';
            if (!SALE_IMAGE_PATTERNS.some(pattern => pattern.test(src))) return;
            hide(img, `sale image ${src.substring(src.lastIndexOf('/') + 1)}`);
            // If the parent only contains this image and no important text, hide parent too
            const parent = img.parentElement;
            if (parent && parent.children.length === 1 && parent.textContent.trim().length < 5) {
                hide(parent, 'parent container of sale image');
            }
        });

        // Hide elements with line-through style (crossed prices)
        card.querySelectorAll('*').forEach(el => {
            if (!getComputedStyle(el).textDecoration.includes('line-through')) return;
            // Only hide if it looks like a price or promotional text
            if (/[\d,]+[€$¥£₽]|%|off|sale/i.test(el.textContent.trim())) hide(el, 'crossed price');
        });
    }

    // The "11.11 Sale" strip at the bottom of the product image ("--scarf--") also hosts
    // AliHelper's seller-trust badge (a.ah-rating-container, height: 100% of the strip),
    // so only make AliExpress's own strip image invisible; keep the strip's box.
    const SCARF_CSS = `
        html.ae-cleanup [class*="--scarf--"] > img {
            visibility: hidden !important;
        }`;

    // The "Free shipping / No import charges / ..." service line is a vertical carousel:
    // a fixed-height box whose slider is moved by transform, with the first item cloned
    // at the end for a seamless loop. Freeze it: drop the clone and show all items inline,
    // "A / B / C", wrapping if needed.
    const STATIC_SERVICES_CSS = `
        html.ae-cleanup [class*="--services--"] {
            height: auto !important; overflow: visible !important;
        }
        html.ae-cleanup [class*="--sliderAnimation--"] {
            transform: none !important; transition: none !important; animation: none !important;
        }
        html.ae-cleanup [class*="--serviceItem--"] {
            display: inline !important; height: auto !important; white-space: normal !important;
        }
        html.ae-cleanup [class*="--serviceItem--"]:last-child:not(:first-child) {
            display: none !important;
        }
        html.ae-cleanup [class*="--serviceItem--"]:not(.ae-garbage) ~ [class*="--serviceItem--"]::before {
            content: " / "; color: #999;
        }`;

    // Doubled class: beats the "display: inline !important" service-item rule above.
    const MARKED_CSS = `
        html.ae-cleanup .ae-garbage.ae-garbage, html.ae-cleanup .ae-hidden.ae-hidden {
            display: none !important;
        }`;

    // Panel's "?" link to the homepage
    const PANEL_CSS = `
        #ae-filter-about {
            position: absolute; top: 7px; right: 7px; box-sizing: border-box; padding: 0; appearance: none;
            width: 18px; height: 18px; border-radius: 50%; border: 1px solid #bbb;
            font: bold 12px/16px sans-serif; text-align: center; text-decoration: none;
            color: #888; background: transparent; cursor: pointer;
            transition: color .15s, background-color .15s, border-color .15s;
        }
        #ae-filter-about:hover, #ae-filter-about:focus-visible {
            color: #fff; background-color: #555; border-color: #555; outline: none;
        }`;

    function injectCleanupCss() {
        const style = document.createElement('style');
        style.textContent = CSS_GARBAGE_SELECTORS.map(sel => `html.ae-cleanup ${sel}`).join(',\n')
            + ' { display: none !important; }\n' + SCARF_CSS + STATIC_SERVICES_CSS + MARKED_CSS + PANEL_CSS;
        document.head.appendChild(style);
    }

    function applyCleanupClass() {
        document.documentElement.classList.toggle('ae-cleanup', config.cleanupEnabled);
    }

    // Promo labels ("Combo Blast", "Bundle Deal", ...) are small badge elements whose
    // whole text is the keyword. Class names are hashed and change (was "kt_*", now
    // "new--title--*"), so match by text instead. Exact match avoids hiding products
    // whose title merely mentions a keyword.
    const PROMO_KEYWORDS_LC = PROMO_KEYWORDS.map(k => k.toLowerCase());
    // The "Combo deal ›" link next to the price is a --rainbow-- block in every site language
    // (e.g. Russian "Комбо-предложение"), so it's matched by class before falling back to text.
    const PROMO_SELECTOR = '[class*="--price--"] > [class*="--rainbow--"]';
    function findPromoLabel(card) {
        const promo = card.querySelector(PROMO_SELECTOR);
        if (promo) return promo;
        for (const el of card.querySelectorAll('span, div')) {
            const text = el.textContent.trim();
            if (text.length > 30) continue;
            if (PROMO_KEYWORDS_LC.includes(text.toLowerCase())) return el;
        }
        return null;
    }

    // True if something other than this script (e.g. an ad blocker hiding sponsored
    // "Ad" cards) hides the card. This script only ever sets a plain inline
    // "display: none", so an !important one, or a stylesheet rule, is someone else's.
    // Side effect: clears our own inline display so the card starts visible.
    function isHiddenByOthers(card) {
        if (card.style.getPropertyPriority('display') === 'important') {
            return card.style.display === 'none'; // leave their style untouched
        }
        card.style.display = '';
        return getComputedStyle(card).display === 'none';
    }

    function hideLowRatedAndPromoItems() {
        let hiddenCount = 0;
        let hiddenByOthersCount = 0; // hidden by others, would be shown by us
        const cards = document.querySelectorAll(
            '.search-item-card-wrapper-gallery, [class*="-waterfall-pc-container"] .productContainer, '
            + '[class*="listLayout--"] > [class*="listItem--"]' // narrow-window one-column list
        );

        log(`[Filter] Processing ${cards.length} cards`);
        applyCleanupClass();

        cards.forEach((card, index) => {
            const hiddenByOthers = isHiddenByOthers(card);
            const hide = () => {
                if (!hiddenByOthers) card.style.display = 'none';
                hiddenCount++;
            };

            markTextGarbage(card);
            // Statistical error next to the rating; on hidden cards too, so none is left stale
            updateRatingError(card);

            if (!config.filterEnabled) {
                if (hiddenByOthers) hiddenByOthersCount++;
                // Even if filter is disabled, still clean the cards if cleanup is enabled
                cleanCard(card);
                return;
            }

            // Check for promo items
            const promoElement = findPromoLabel(card);
            if (promoElement) {
                hide();
                log(`[Filter] Hidden promo: ${promoElement.textContent.trim().substring(0, 30)}`);
                return;
            }

            // Check rating and votes
            const ratingSpan = findRatingInCard(card);
            const rating = ratingSpan ? parseNumber(ratingSpan.textContent) : null;

            if (rating === null) {
                hide();
                log(`[Filter] Hidden no rating: card ${index}`);
                return;
            }

            const votes = extractVotesNearRating(card, ratingSpan);
            // Check minimum votes requirement
            if (votes < config.minVotes) {
                hide();
                log(`[Filter] Hidden low votes ${votes} (min: ${config.minVotes}): card ${index}`);
                return;
            }

            if (rating < config.minRating) {
                hide();
                log(`[Filter] Hidden low rating ${rating}: card ${index}`);
                return;
            }

            /*  Uncomment this, if you use AliHelper and want to use it for filtering. Note that this is kinda unstable.

            // Check seller rating
            const sellerRatingEl = card.querySelector('.ah-rating');
            const sellerRating = sellerRatingEl ? parseNumber(sellerRatingEl.textContent) : null;

            if (sellerRating !== null && sellerRating < MIN_SELLER_SCORE) {
                hide();
                log(`[Filter] Hidden bad seller ${sellerRating}%: card ${index}`);
                return;
            }

            // Also hide if there's a red "unreliable seller" label
            const badSellerLabel = card.querySelector('.ah-label-red');
            if (badSellerLabel) {
                hide();
                log(`[Filter] Hidden unreliable seller: card ${index}`);
                return;
            }
            */

            if (hiddenByOthers) hiddenByOthersCount++;

            // Clean the card (remove promotional elements)
            cleanCard(card);
        });

        const othersText = hiddenByOthersCount ? `\n+${hiddenByOthersCount} ads hidden by ad blocker` : '';
        log(`[Filter] Hidden: ${hiddenCount}/${cards.length} cards${othersText.replace('\n', ', ')}`);
        updateStats(`Hidden: ${hiddenCount}/${cards.length} cards${othersText}`); // \n: second line (pre-line)
    }

    function updateStats(newText) {
        const stats = document.getElementById('ae-filter-stats');
        if (stats) stats.textContent = newText;
        const fab = document.getElementById('ae-filter-fab');
        if (fab) fab.title = `Filter+\n${newText}`;
    }

    // Start collapsed on small windows (mobile, popups); clicking the round button opens
    // the panel, clicking the "Filter+" title collapses it again.
    const SMALL_WINDOW_QUERY = '(max-width: 768px), (max-height: 600px)';
    const HOMEPAGE_URL = 'https://github.com/anrinion/aliexpress-filter';
    const FILTER_ICON_SVG = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
            <path d="M4 6h16M7 12h10M10 18h4"/>
        </svg>`;

    function createControlPanel() {
        const corner = { position: 'fixed', bottom: '20px', right: '20px', zIndex: '9999' };
        const surface = {
            backdropFilter: 'blur(8px)',
            backgroundColor: 'rgba(255, 255, 255, 0.95)',
            border: '1px solid #ccc',
            boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
            color: '#333',
        };

        const fab = document.createElement('button');
        fab.id = 'ae-filter-fab';
        fab.type = 'button';
        fab.title = 'Filter+';
        fab.setAttribute('aria-label', 'Open Filter+');
        fab.innerHTML = FILTER_ICON_SVG;
        Object.assign(fab.style, corner, surface, {
            width: '40px',
            height: '40px',
            padding: '0',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
        });

        const panel = document.createElement('div');
        panel.id = 'ae-filter-panel';
        Object.assign(panel.style, corner, surface, {
            padding: '15px',
            borderRadius: '8px',
            fontSize: '12px',
            maxWidth: '220px',
            fontFamily: 'sans-serif'
        });

        panel.innerHTML = `
            <button type="button" id="ae-filter-about"
               title="Filtering is done by an installed userscript, not by AliExpress. Click to open the userscript's homepage.">?</button>
            <div style="font-weight:bold; margin-bottom: 8px; font-size: 13px; text-align:center; color:#222; cursor: pointer;" id="ae-filter-header" title="Collapse">Filter+</div>
            <div id="ae-filter-body">
                <label><input type="checkbox" id="ae-toggle-filter"> Filter</label><br>
                <label><input type="checkbox" id="ae-toggle-cleanup"> Cleanup</label><br>
                <label><input type="checkbox" id="ae-toggle-debug"> Debug</label><br><br>
                <label>Min Rating: <span id="ae-rating-val">${config.minRating}</span></label><br>
                <input type="range" min="3.5" max="5" step="0.1" value="${config.minRating}" id="ae-min-rating"><br>
                <label>Min Votes: <span id="ae-votes-val">${config.minVotes}</span></label><br>
                <input type="range" min="0" max="500" step="10" value="${config.minVotes}" id="ae-min-votes"><br><br>
                <div id="ae-filter-stats" style="margin-top:6px; font-size:11px; color:#555; text-align:center; white-space:pre-line;">Hidden: 0</div>
            </div>`;

        const setCollapsed = collapsed => {
            fab.style.display = collapsed ? 'flex' : 'none';
            panel.style.display = collapsed ? 'none' : 'block';
        };
        setCollapsed(window.matchMedia(SMALL_WINDOW_QUERY).matches);
        fab.onclick = () => setCollapsed(false);

        document.body.appendChild(fab);
        document.body.appendChild(panel);

        document.getElementById('ae-toggle-filter').checked = config.filterEnabled;
        document.getElementById('ae-toggle-cleanup').checked = config.cleanupEnabled;
        document.getElementById('ae-toggle-debug').checked = config.debugEnabled;

        document.getElementById('ae-toggle-filter').onchange = e => {
            config.filterEnabled = e.target.checked;
            saveConfig();
        };
        document.getElementById('ae-toggle-cleanup').onchange = e => {
            config.cleanupEnabled = e.target.checked;
            saveConfig();
        };
        document.getElementById('ae-toggle-debug').onchange = e => {
            config.debugEnabled = e.target.checked;
            saveConfig();
        };

        document.getElementById('ae-filter-header').onclick = () => setCollapsed(true);
        // A button, not a link: AliExpress's click tracking appends "?spm=..." to every <a href> on the page
        document.getElementById('ae-filter-about').onclick = () => window.open(HOMEPAGE_URL, '_blank', 'noopener');
        document.getElementById('ae-min-rating').oninput = e => {
            config.minRating = parseFloat(e.target.value);
            document.getElementById('ae-rating-val').textContent = config.minRating;
            saveConfig();
        };
        document.getElementById('ae-min-votes').oninput = e => {
            config.minVotes = parseInt(e.target.value);
            document.getElementById('ae-votes-val').textContent = config.minVotes;
            saveConfig();
        };
    }

    function monitorUrlChanges() {
        setInterval(() => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                lastUrl = currentUrl;
                log('[Filter] URL changed → restarting filter');
                setTimeout(() => hideLowRatedAndPromoItems(), 1000);
            }
        }, 1000);
    }


    let lastRun = 0;
    let pendingTimeout = null;
    const MIN_DELAY = 300; // ms
    function throttle(f) {
        const now = Date.now();

        if (now - lastRun > MIN_DELAY) {
            lastRun = now;
            f();
        } else if (!pendingTimeout) {
            pendingTimeout = setTimeout(() => {
                lastRun = Date.now();
                pendingTimeout = null;
                f();
            }, MIN_DELAY);
        }
    }

    function throttledHide() {
        throttle(() => {
            log("Execution allowed, starting...");
            hideLowRatedAndPromoItems();
        });
    }

    pendingTimeout = setTimeout(throttledHide, 1000);

    const observer = new MutationObserver(throttledHide);
    observer.observe(document.body, { childList: true, subtree: true });

    monitorUrlChanges();

    // Launch
    injectCleanupCss();
    applyCleanupClass();
    createControlPanel();
    log('[AliExpress Filter v2.5] started');
})();