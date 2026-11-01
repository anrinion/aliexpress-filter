// ==UserScript==
// @name         AliExpress Filter
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  Hide low-rated, unrated, low-seller-score, low-votes and promo items on AliExpress
// @match        *://*.aliexpress.com/*
// @grant        none
// @license      MIT
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

        // Partner/affiliate labels
        '.ah-ref-label', // "Партнерская ссылка"

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
    let seenCards = new WeakSet();

    function loadConfig() {
        const stored = JSON.parse(localStorage.getItem('aeFilterConfig') || '{}');
        return { ...defaultConfig, ...stored };
    }

    function saveConfig() {
        localStorage.setItem('aeFilterConfig', JSON.stringify(config));
        seenCards = new WeakSet();
        hideLowRatedAndPromoItems();
    }

    function log(message) {
        if (config.debugEnabled) {
            console.log(message);
        }
    }

    function parseNumber(text) {
        const match = /* text.match(/([0-9.]+)/) */ text.match(/^([0-5](?:\.\d)?)$/);
        return match ? parseFloat(match[1]) : null;
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

    function parseVotesCount(text) {
        // "29 sold", "1,000+ sold", "3K+ sold", "1.5K+ sold", "2M+ sold"
        const match = text.match(/\b(\d[\d,.]*)\s*([km])?\+?\s*sold\b/i);
        if (!match) return null;
        const [, number, suffix] = match;
        if (!suffix) return parseInt(number.replace(/[,.]/g, ''));
        const multiplier = suffix.toLowerCase() === 'k' ? 1000 : 1000000;
        return Math.round(parseFloat(number.replace(',', '.')) * multiplier);
    }

    function extractVotesNearRating(card, ratingSpan) {
        const context = ratingSpan.closest('div')?.parentElement;
        if (!context) return 0;

        const elements = context.querySelectorAll('*');
        for (const el of elements) {
            const txt = el.textContent.trim();
            const votes = parseVotesCount(txt);
            if (votes) {
                return votes;
            }
        }

        return 0;
    }

    function findRatingInCard(card) {
        let ratingSpan = card.querySelector('span[class*="review_Star_"]');
        if (ratingSpan) return ratingSpan;

        const allDivs = [...card.querySelectorAll('div')].reverse(); // deepest first

        for (let div of allDivs) {
            const span = [...div.querySelectorAll('span')].find(
                s => /^[0-5](\.\d)?$/.test(s.textContent.trim())
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

    function addRatingError(card) {
        const ratingSpan = findRatingInCard(card);
        if (!ratingSpan) return;
        if (ratingSpan.nextSibling && ratingSpan.nextSibling.classList?.contains('ae-rating-error')) return;

        const rating = parseNumber(ratingSpan.textContent);
        if (!rating) return;

        const votes = extractVotesNearRating(card, ratingSpan);
        if (votes > 0) {
            const error = calculateRatingError(rating, votes);
            if (error !== null) {
                const errorSpan = document.createElement('span');
                errorSpan.className = 'ae-rating-error';
                errorSpan.style.fontSize = '1em';
                errorSpan.style.color = '#666';
                errorSpan.style.marginLeft = '2px';
                errorSpan.textContent = `±${error}`;
                ratingSpan.parentNode.insertBefore(errorSpan, ratingSpan.nextSibling);
            }
        }
    }


    function cleanCard(card) {
        if (seenCards.has(card)) return;
        seenCards.add(card);

        if (!config.cleanupEnabled) return;

        let cardCleanedCount = 0;

        // Remove elements by selector
        GARBAGE_SELECTORS.forEach(sel => {
            const elements = card.querySelectorAll(sel);
            elements.forEach(el => {
                // Don't hide if it contains important info
                const text = el.textContent.trim();
                const isImportant = /^\d+\.\d+$/.test(text) || // rating like "4.7"
                                  /\d+\+?\s*sold/i.test(text) || // sold count
                                  /^[\d,]+\.?\d*[€$¥£₽]/.test(text); // main price

                if (!isImportant) {
                    el.style.display = 'none';
                    cardCleanedCount++;
                    log(`[Clean] Hidden by selector "${sel}": "${text.substring(0, 30)}"`);
                }
            });
        });

        // Specifically target sale images by URL pattern
        const allImages = card.querySelectorAll('img');
        allImages.forEach(img => {
            const src = img.src || '';
            const shouldHide = SALE_IMAGE_PATTERNS.some(pattern => pattern.test(src));

            if (shouldHide) {
                // Hide the image and potentially its parent if it's just a container
                img.style.display = 'none';
                cardCleanedCount++;
                log(`[Clean] Hidden sale image: ${src.substring(src.lastIndexOf('/') + 1)}`);

                // If the parent only contains this image and no important text, hide parent too
                const parent = img.parentElement;
                if (parent && parent.children.length === 1 && parent.textContent.trim().length < 5) {
                    parent.style.display = 'none';
                    log(`[Clean] Hidden parent container of sale image`);
                }
            }
        });

        // Hide elements with line-through style (crossed prices)
        const allElements = card.querySelectorAll('*');
        allElements.forEach(el => {
            const style = window.getComputedStyle(el);
            if (style.textDecoration.includes('line-through')) {
                const text = el.textContent.trim();
                // Only hide if it looks like a price or promotional text
                if (/[\d,]+[€$¥£₽]|%|off|sale/i.test(text)) {
                    el.style.display = 'none';
                    cardCleanedCount++;
                    log(`[Clean] Hidden crossed price: "${text}"`);
                }
            }
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
        html.ae-cleanup [class*="--serviceItem--"] + [class*="--serviceItem--"]::before {
            content: " / "; color: #999;
        }`;

    function injectCleanupCss() {
        const style = document.createElement('style');
        style.textContent = CSS_GARBAGE_SELECTORS.map(sel => `html.ae-cleanup ${sel}`).join(',\n')
            + ' { display: none !important; }\n' + SCARF_CSS + STATIC_SERVICES_CSS;
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
    function findPromoLabel(card) {
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

            // Add statistical error to rating display
            addRatingError(card);
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
    log('[AliExpress Filter v2.4] started');
})();