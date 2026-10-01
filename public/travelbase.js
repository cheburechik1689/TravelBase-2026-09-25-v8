function __tbReady(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
  else fn();
}

        // ─── Monkey-patch fetch to add ngrok-skip-browser-warning header ───
        // This prevents ngrok interstitial page from blocking Telegram WebView on iOS
        (function() {
            const _origFetch = window.fetch;
            window.fetch = function(input, init) {
                init = init || {};
                init.headers = init.headers || {};
                if (init.headers instanceof Headers) {
                    init.headers.set('ngrok-skip-browser-warning', 'true');
                } else {
                    init.headers['ngrok-skip-browser-warning'] = 'true';
                }
                return _origFetch.call(this, input, init);
            };
        })();

        // ─── Устойчивый парсинг JSON ───
        // Продакшн-сборка иногда оборачивает ответ API в HTML (<!doctype html>...JSON...</body></html>).
        // Патчим Response.prototype.json один раз: сначала читаем текст, затем извлекаем JSON.
        (function() {
            if (window.__tbJsonPatched) return;
            window.__tbJsonPatched = true;
            Response.prototype.json = function() {
                return this.text().then(function(raw) {
                    try { return JSON.parse(raw); } catch (e) {
                        // Ищем начало объекта/массива после возможного HTML-префикса
                        let start = raw.indexOf('{"success"');
                        if (start < 0) start = raw.indexOf('{');
                        const endObj = raw.lastIndexOf('}');
                        if (start >= 0 && endObj > start) {
                            try { return JSON.parse(raw.slice(start, endObj + 1)); } catch (e2) {}
                        }
                        const startArr = raw.indexOf('[');
                        const endArr = raw.lastIndexOf(']');
                        if (startArr >= 0 && endArr > startArr) {
                            try { return JSON.parse(raw.slice(startArr, endArr + 1)); } catch (e3) {}
                        }
                        throw e;
                    }
                });
            };
        })();

        const tg = window.Telegram?.WebApp;
        if (tg) {
            tg.ready();
            tg.expand();
        }
        let tripData = {};
        let leafletMap = null;
        let planDays = [];
        let currentDayIndex = 0;
        let currentPlaceInfo = [];
        let currentRouteData = null;
        let tripMode = 'dates';
        let destCoords = null;
        let weatherData = [];
        let weatherType = 'forecast';
        let currentPlanJson = null;
        let currentTripId = null;
        const TB_ACTIVE_KEY = 'tb.activeTrip.v1';

        // ─── Multi-day map system ───
        const dayColors = ['#005F60','#3C2433','#2D68C4','#267D7E','#5B8DD9'];
        let allDaysPlaceInfo = {};   // {dayIndex: [{num,name,lat,lon}]}
        let allDaysRouteData = {};   // {dayIndex: routeData}
        let allDaysMapLayers = {};   // {dayIndex: L.layerGroup}
        let fxRatesToRub = { RUB: 1 };
        const GOOGLE_MAPS_API_KEY = '';

        function createGoogleTileLayer() {
            return L.tileLayer(`https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&key=${GOOGLE_MAPS_API_KEY}`, {
                attribution: '© Google',
                maxZoom: 19,
                subdomains: ['mt0','mt1','mt2','mt3']
            });
        }

        function createFallbackTileLayer() {
            return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap',
                maxZoom: 19
            });
        }

        function addMapTileLayer(map) {
            if (typeof L === 'undefined') return null;
            if (GOOGLE_MAPS_API_KEY) {
                try {
                    const googleLayer = createGoogleTileLayer();
                    googleLayer.on('tileerror', function() {
                        if (googleLayer._map) {
                            map.removeLayer(googleLayer);
                            createFallbackTileLayer().addTo(map);
                        }
                    });
                    googleLayer.addTo(map);
                    return googleLayer;
                } catch (e) {
                    // если Google Maps не доступен — fallback на стандартные тайлы
                }
            }
            return createFallbackTileLayer().addTo(map);
        }

        // ─── Currency helper ───
        const _currencySymbols = {RUB:'₽', USD:'$', EUR:'€', GBP:'£', JPY:'¥', CNY:'¥', TRY:'₺', THB:'฿', KRW:'₩', INR:'₹', AED:'د.إ', PLN:'zł', CZK:'Kč', HUF:'Ft', SEK:'kr', NOK:'kr', DKK:'kr', CHF:'CHF', CAD:'C$', AUD:'A$', NZD:'NZ$', SGD:'S$', HKD:'HK$', BRL:'R$', MXN:'MX$', ILS:'₪', ZAR:'R'};
        function getCurrSym() {
            const code = tripData.currencyCode || 'RUB';
            return _currencySymbols[code] || code;
        }

        async function loadCurrencyRates() {
            try {
                const resp = await fetch('/api/currency-rates');
                const data = await resp.json();
                if (data.success && data.ratesToRub) {
                    fxRatesToRub = { ...fxRatesToRub, ...data.ratesToRub };
                }
            } catch (e) {
                // тихий fallback на локальные суммы
            }
        }

        function detectCurrencyCodeFromText(line = '') {
            const s = String(line || '').toUpperCase();
            if (/[₽]|\bRUB\b|\bРУБ\b|\bРУБЛ/.test(s)) return 'RUB';
            if (/[$]|\bUSD\b|\bДОЛЛАР/.test(s)) return 'USD';
            if (/[€]|\bEUR\b|\bЕВРО/.test(s)) return 'EUR';
            if (/[£]|\bGBP\b/.test(s)) return 'GBP';
            if (/[¥]|\bJPY\b|\bCNY\b/.test(s)) return 'JPY';
            if (/[₺]|\bTRY\b/.test(s)) return 'TRY';
            return null;
        }

        function convertAmountToUserCurrency(amount, fromCode) {
            const toCode = (tripData.currencyCode || 'RUB').toUpperCase();
            if (!amount || amount <= 0) return amount;
            if (!fromCode || fromCode === toCode) return amount;
            const fromRate = fxRatesToRub[fromCode] || null;
            const toRate = fxRatesToRub[toCode] || null;
            if (!fromRate || !toRate) return amount;
            const inRub = amount * fromRate;
            return inRub / toRate;
        }

        // ─── Budget SVG icons (Lucide-style, stroke-based) ───
        const budgetIcons = {
            food: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>',
            transport: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 21h10"/><path d="M12 17v4"/></svg>',
            tickets: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>',
            hotel: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Z"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/></svg>',
            shopping: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
            sim: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" x2="12.01" y1="20" y2="20"/></svg>',
            other: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>',
            total: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>'
        };
        const budgetIconColors = {
            food: '#005F60', transport: '#4A9496', tickets: '#5B8DD9',
            hotel: '#9A7A8E', shopping: '#5B8DD9', sim: '#6B4A5E', other: '#8A8386', total: '#005F60'
        };
        function budgetIconHtml(key) {
            const svg = budgetIcons[key] || budgetIcons.other;
            const bg = budgetIconColors[key] || '#8A8386';
            return `<div class="br-icon" style="background:${bg}15; color:${bg};">${svg}</div>`;
        }

        // ─── Booking SVG icons ───
        const bookingSvgIcons = {
            flights: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>',
            hotel: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Z"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/></svg>',
            search: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>'
        };

        const countriesData = [
            { name: 'Франция', flag: '🇫🇷', cities: ['Париж', 'Ницца', 'Лион', 'Марсель', 'Бордо'] },
            { name: 'Италия', flag: '🇮🇹', cities: ['Рим', 'Милан', 'Флоренция', 'Венеция', 'Неаполь'] },
            { name: 'Испания', flag: '🇪🇸', cities: ['Барселона', 'Мадрид', 'Валенсия', 'Севилья', 'Малага'] },
            { name: 'Германия', flag: '🇩🇪', cities: ['Берлин', 'Мюнхен', 'Гамбург', 'Кёльн', 'Франкфурт'] },
            { name: 'Турция', flag: '🇹🇷', cities: ['Стамбул', 'Анталья', 'Измир', 'Анкара', 'Бодрум'] },
            { name: 'ОАЭ', flag: '🇦🇪', cities: ['Дубай', 'Абу-Даби', 'Шарджа', 'Аджман', 'Рас-эль-Хайма'] },
            { name: 'Таиланд', flag: '🇹🇭', cities: ['Бангкок', 'Пхукет', 'Чиангмай', 'Паттайя', 'Самуи'] },
            { name: 'США', flag: '🇺🇸', cities: ['Нью-Йорк', 'Лос-Анджелес', 'Майами', 'Лас-Вегас', 'Сан-Франциско'] },
            { name: 'Япония', flag: '🇯🇵', cities: ['Токио', 'Осака', 'Киото', 'Йокогама', 'Нара'] },
            { name: 'Великобритания', flag: '🇬🇧', cities: ['Лондон', 'Эдинбург', 'Манчестер', 'Ливерпуль', 'Бристоль'] },
            { name: 'Португалия', flag: '🇵🇹', cities: ['Лиссабон', 'Порту', 'Фаро', 'Коимбра', 'Брага'] },
            { name: 'Греция', flag: '🇬🇷', cities: ['Афины', 'Салоники', 'Родос', 'Ираклион', 'Ханья'] },
            { name: 'Нидерланды', flag: '🇳🇱', cities: ['Амстердам', 'Роттердам', 'Гаага', 'Утрехт', 'Эйндховен'] },
            { name: 'Бельгия', flag: '🇧🇪', cities: ['Брюссель', 'Брюгге', 'Гент', 'Антверпен', 'Льеж'] },
            { name: 'Швейцария', flag: '🇨🇭', cities: ['Цюрих', 'Женева', 'Берн', 'Люцерн', 'Лозанна'] },
            { name: 'Австрия', flag: '🇦🇹', cities: ['Вена', 'Зальцбург', 'Инсбрук', 'Грац', 'Линц'] },
            { name: 'Чехия', flag: '🇨🇿', cities: ['Прага', 'Брно', 'Карловы Вары', 'Чески-Крумлов', 'Острава'] },
            { name: 'Польша', flag: '🇵🇱', cities: ['Варшава', 'Краков', 'Гданьск', 'Вроцлав', 'Познань'] },
            { name: 'Венгрия', flag: '🇭🇺', cities: ['Будапешт', 'Дебрецен', 'Сегед', 'Печ', 'Эгер'] },
            { name: 'Хорватия', flag: '🇭🇷', cities: ['Дубровник', 'Сплит', 'Загреб', 'Задар', 'Пула'] },
            { name: 'Швеция', flag: '🇸🇪', cities: ['Стокгольм', 'Гётеборг', 'Мальмё', 'Уппсала', 'Лунд'] },
            { name: 'Норвегия', flag: '🇳🇴', cities: ['Осло', 'Берген', 'Тронхейм', 'Ставангер', 'Тромсё'] },
            { name: 'Дания', flag: '🇩🇰', cities: ['Копенгаген', 'Орхус', 'Оденсе', 'Ольборг', 'Биллунн'] },
            { name: 'Финляндия', flag: '🇫🇮', cities: ['Хельсинки', 'Турку', 'Тампере', 'Рованиеми', 'Оулу'] },
            { name: 'Ирландия', flag: '🇮🇪', cities: ['Дублин', 'Голуэй', 'Корк', 'Лимерик', 'Килларни'] },
            { name: 'Исландия', flag: '🇮🇸', cities: ['Рейкьявик', 'Акюрейри', 'Хусавик', 'Селфосс', 'Вик'] },
            { name: 'Канада', flag: '🇨🇦', cities: ['Торонто', 'Ванкувер', 'Монреаль', 'Квебек', 'Калгари'] },
            { name: 'Мексика', flag: '🇲🇽', cities: ['Мехико', 'Канкун', 'Гвадалахара', 'Монтеррей', 'Плайя-дель-Кармен'] },
            { name: 'Бразилия', flag: '🇧🇷', cities: ['Рио-де-Жанейро', 'Сан-Паулу', 'Салвадор', 'Бразилиа', 'Флорианополис'] },
            { name: 'Аргентина', flag: '🇦🇷', cities: ['Буэнос-Айрес', 'Мендоса', 'Кордова', 'Барилоче', 'Сальта'] },
            { name: 'Чили', flag: '🇨🇱', cities: ['Сантьяго', 'Вальпараисо', 'Пунта-Аренас', 'Винья-дель-Мар', 'Пукон'] },
            { name: 'Перу', flag: '🇵🇪', cities: ['Лима', 'Куско', 'Арекипа', 'Пуно', 'Трухильо'] },
            { name: 'Колумбия', flag: '🇨🇴', cities: ['Богота', 'Медельин', 'Картахена', 'Кали', 'Санта-Марта'] },
            { name: 'Коста-Рика', flag: '🇨🇷', cities: ['Сан-Хосе', 'Ла-Фортуна', 'Тамариндо', 'Пуэрто-Вьехо', 'Либерия'] },
            { name: 'Доминикана', flag: '🇩🇴', cities: ['Пунта-Кана', 'Санто-Доминго', 'Пуэрто-Плата', 'Самана', 'Ла-Романа'] },
            { name: 'Куба', flag: '🇨🇺', cities: ['Гавана', 'Варадеро', 'Тринидад', 'Сантьяго-де-Куба', 'Сьенфуэгос'] },
            { name: 'Ямайка', flag: '🇯🇲', cities: ['Кингстон', 'Монтего-Бей', 'Негрил', 'Очо-Риос', 'Порт-Антонио'] },
            { name: 'Марокко', flag: '🇲🇦', cities: ['Марракеш', 'Касабланка', 'Фес', 'Рабат', 'Танжер'] },
            { name: 'Египет', flag: '🇪🇬', cities: ['Каир', 'Хургада', 'Шарм-эль-Шейх', 'Луксор', 'Асуан'] },
            { name: 'Тунис', flag: '🇹🇳', cities: ['Тунис', 'Сус', 'Хаммамет', 'Монастир', 'Джерба'] },
            { name: 'ЮАР', flag: '🇿🇦', cities: ['Кейптаун', 'Йоханнесбург', 'Дурбан', 'Претория', 'Порт-Элизабет'] },
            { name: 'Кения', flag: '🇰🇪', cities: ['Найроби', 'Момбаса', 'Найваша', 'Накуру', 'Ламу'] },
            { name: 'Танзания', flag: '🇹🇿', cities: ['Дар-эс-Салам', 'Занзибар', 'Аруша', 'Мванза', 'Моши'] },
            { name: 'Сейшелы', flag: '🇸🇨', cities: ['Виктория', 'Бо-Валлон', 'Анс-Лацио', 'Анс-Руаяль', 'Ла-Диг'] },
            { name: 'Маврикий', flag: '🇲🇺', cities: ['Порт-Луи', 'Гранд-Бэй', 'Флик-ан-Флак', 'Ле-Морн', 'Маэбур'] },
            { name: 'Индия', flag: '🇮🇳', cities: ['Дели', 'Мумбаи', 'Джайпур', 'Агра', 'Гоа'] },
            { name: 'Китай', flag: '🇨🇳', cities: ['Пекин', 'Шанхай', 'Сиань', 'Гуанчжоу', 'Шэньчжэнь'] },
            { name: 'Южная Корея', flag: '🇰🇷', cities: ['Сеул', 'Пусан', 'Инчхон', 'Кёнджу', 'Чеджу'] },
            { name: 'Сингапур', flag: '🇸🇬', cities: ['Сингапур', 'Марина-Бэй', 'Сентоза', 'Орчард-роуд', 'Чанги'] },
            { name: 'Малайзия', flag: '🇲🇾', cities: ['Куала-Лумпур', 'Пенанг', 'Лангкави', 'Малакка', 'Кота-Кинабалу'] },
            { name: 'Индонезия', flag: '🇮🇩', cities: ['Джакарта', 'Бали', 'Джокьякарта', 'Сурабая', 'Бандунг'] },
            { name: 'Вьетнам', flag: '🇻🇳', cities: ['Ханой', 'Хошимин', 'Дананг', 'Нячанг', 'Хойан'] },
            { name: 'Камбоджа', flag: '🇰🇭', cities: ['Пномпень', 'Сиемреап', 'Сиануквиль', 'Баттамбанг', 'Кампот'] },
            { name: 'Филиппины', flag: '🇵🇭', cities: ['Манила', 'Себу', 'Боракай', 'Палаван', 'Давао'] },
            { name: 'Австралия', flag: '🇦🇺', cities: ['Сидней', 'Мельбурн', 'Брисбен', 'Перт', 'Аделаида'] },
            { name: 'Новая Зеландия', flag: '🇳🇿', cities: ['Окленд', 'Веллингтон', 'Квинстаун', 'Крайстчерч', 'Роторуа'] },
            { name: 'Израиль', flag: '🇮🇱', cities: ['Тель-Авив', 'Иерусалим', 'Хайфа', 'Эйлат', 'Назарет'] },
            { name: 'Иордания', flag: '🇯🇴', cities: ['Амман', 'Петра', 'Акаба', 'Мадаба', 'Джераш'] },
            { name: 'Саудовская Аравия', flag: '🇸🇦', cities: ['Эр-Рияд', 'Джидда', 'Мекка', 'Медина', 'Аль-Ула'] },
            { name: 'Катар', flag: '🇶🇦', cities: ['Доха', 'Аль-Вакра', 'Аль-Хор', 'Лусаил', 'Аль-Райян'] },
            { name: 'Оман', flag: '🇴🇲', cities: ['Маскат', 'Салала', 'Низва', 'Сур', 'Сохар'] },
            { name: 'Грузия', flag: '🇬🇪', cities: ['Тбилиси', 'Батуми', 'Кутаиси', 'Мцхета', 'Сигнахи'] },
            { name: 'Армения', flag: '🇦🇲', cities: ['Ереван', 'Гюмри', 'Дилижан', 'Севан', 'Вагаршапат'] },
            { name: 'Азербайджан', flag: '🇦🇿', cities: ['Баку', 'Гянджа', 'Шеки', 'Габала', 'Ленкорань'] },
            { name: 'Казахстан', flag: '🇰🇿', cities: ['Алматы', 'Астана', 'Шымкент', 'Актау', 'Караганда'] },
            { name: 'Узбекистан', flag: '🇺🇿', cities: ['Ташкент', 'Самарканд', 'Бухара', 'Хива', 'Фергана'] },
            { name: 'Непал', flag: '🇳🇵', cities: ['Катманду', 'Покхара', 'Лумбини', 'Читван', 'Нагаркот'] },
            { name: 'Шри-Ланка', flag: '🇱🇰', cities: ['Коломбо', 'Канди', 'Галле', 'Элла', 'Нувара-Элия'] },
            { name: 'Мальдивы', flag: '🇲🇻', cities: ['Мале', 'Маарифуши', 'Ари', 'Баа', 'Лааму'] },
            { name: 'Болгария', flag: '🇧🇬', cities: ['София', 'Пловдив', 'Варна', 'Бургас', 'Несебр'] },
            { name: 'Румыния', flag: '🇷🇴', cities: ['Бухарест', 'Брашов', 'Сибиу', 'Клуж-Напока', 'Констанца'] },
            { name: 'Сербия', flag: '🇷🇸', cities: ['Белград', 'Нови-Сад', 'Ниш', 'Суботица', 'Крагуевац'] },
            { name: 'Черногория', flag: '🇲🇪', cities: ['Подгорица', 'Будва', 'Котор', 'Бар', 'Тиват'] },
            { name: 'Словения', flag: '🇸🇮', cities: ['Любляна', 'Блед', 'Марибор', 'Пиран', 'Копер'] },
            { name: 'Словакия', flag: '🇸🇰', cities: ['Братислава', 'Кошице', 'Попрад', 'Жилина', 'Банска-Бистрица'] },
            { name: 'Литва', flag: '🇱🇹', cities: ['Вильнюс', 'Каунас', 'Клайпеда', 'Тракай', 'Шяуляй'] },
            { name: 'Латвия', flag: '🇱🇻', cities: ['Рига', 'Юрмала', 'Даугавпилс', 'Лиепая', 'Сигулда'] },
            { name: 'Эстония', flag: '🇪🇪', cities: ['Таллин', 'Тарту', 'Пярну', 'Нарва', 'Хаапсалу'] },
            { name: 'Кипр', flag: '🇨🇾', cities: ['Лимасол', 'Ларнака', 'Пафос', 'Никосия', 'Айя-Напа'] },
            { name: 'Мальта', flag: '🇲🇹', cities: ['Валлетта', 'Слима', 'Сент-Джулианс', 'Мдина', 'Гозо'] },
            { name: 'Люксембург', flag: '🇱🇺', cities: ['Люксембург', 'Эш-сюр-Альзет', 'Вианден', 'Дикирх', 'Эхтернах'] },
            { name: 'Монако', flag: '🇲🇨', cities: ['Монако', 'Монте-Карло', 'Ла-Кондамин', 'Фонтвьей', 'Монако-Виль'] },
            { name: 'Андорра', flag: '🇦🇩', cities: ['Андорра-ла-Велья', 'Эскальдес', 'Ла-Массана', 'Канильо', 'Ордино'] },
            { name: 'Сан-Марино', flag: '🇸🇲', cities: ['Сан-Марино', 'Борго-Маджоре', 'Серравалле', 'Доманьяно', 'Фаэтано'] },
            { name: 'Албания', flag: '🇦🇱', cities: ['Тирана', 'Саранда', 'Влёра', 'Берат', 'Шкодер'] },
            { name: 'Северная Македония', flag: '🇲🇰', cities: ['Скопье', 'Охрид', 'Битола', 'Струга', 'Тетово'] },
            { name: 'Босния и Герцеговина', flag: '🇧🇦', cities: ['Сараево', 'Мостар', 'Баня-Лука', 'Требинье', 'Яйце'] },
            { name: 'Украина', flag: '🇺🇦', cities: ['Киев', 'Львов', 'Одесса', 'Харьков', 'Черновцы'] },
            { name: 'Беларусь', flag: '🇧🇾', cities: ['Минск', 'Брест', 'Гродно', 'Витебск', 'Гомель'] },
            { name: 'Россия', flag: '🇷🇺', cities: ['Москва', 'Санкт-Петербург', 'Казань', 'Сочи', 'Владивосток', 'Калининград', 'Суздаль', 'Владимир', 'Ярославль', 'Иркутск', 'Горно-Алтайск', 'Петропавловск-Камчатский', 'Дербент', 'Махачкала', 'Петрозаводск', 'Мурманск', 'Нижний Новгород', 'Екатеринбург', 'Алтай', 'Камчатка', 'Дагестан', 'Байкал', 'Карелия'] },
            { name: 'Нигерия', flag: '🇳🇬', cities: ['Лагос', 'Абуджа', 'Кано', 'Ибадан', 'Порт-Харкорт'] },
            { name: 'Гана', flag: '🇬🇭', cities: ['Аккра', 'Кумаси', 'Кейп-Кост', 'Тамале', 'Такоради'] },
            { name: 'Эфиопия', flag: '🇪🇹', cities: ['Аддис-Абеба', 'Лалибэла', 'Гондэр', 'Бахр-Дар', 'Аксум'] },
            { name: 'Уганда', flag: '🇺🇬', cities: ['Кампала', 'Джинджя', 'Энтеббе', 'Мбарара', 'Гулу'] },
            { name: 'Руанда', flag: '🇷🇼', cities: ['Кигали', 'Гисеньи', 'Мусанзе', 'Бутаре', 'Кибуе'] },
            { name: 'Сенегал', flag: '🇸🇳', cities: ['Дакар', 'Сен-Луи', 'Сомон', 'Сали', 'Зигиншор'] },
            { name: 'Намибия', flag: '🇳🇦', cities: ['Виндхук', 'Свакопмунд', 'Валфиш-Бей', 'Опуо', 'Китмансхуп'] },
            { name: 'Ботсвана', flag: '🇧🇼', cities: ['Габороне', 'Маун', 'Касане', 'Франсистаун', 'Орапа'] },
            { name: 'Панама', flag: '🇵🇦', cities: ['Панама-Сити', 'Бокете', 'Колон', 'Давид', 'Бокас-дель-Торо'] },
            { name: 'Эквадор', flag: '🇪🇨', cities: ['Кито', 'Гуаякиль', 'Куэнка', 'Галапагос', 'Баньос'] }
        ];

        // ===== POPULAR DESTINATIONS DATA =====
        // Default fallback list (shown before any API data loads)
        const defaultPopularDestinations = [
            { emoji: '🇫🇷', city: 'Париж', country: 'Франция', image: '/img/destinations/paris.jpg' },
            { emoji: '🇮🇹', city: 'Рим', country: 'Италия', image: '/img/destinations/rome.jpg' },
            { emoji: '🇯🇵', city: 'Токио', country: 'Япония', image: '/img/destinations/tokyo.jpg' },
            { emoji: '🇮🇩', city: 'Бали', country: 'Индонезия', image: '/img/destinations/bali.jpg' },
            { emoji: '🇪🇸', city: 'Барселона', country: 'Испания', image: '/img/destinations/barcelona.jpg' },
            { emoji: '🇹🇷', city: 'Стамбул', country: 'Турция', image: '/img/destinations/istanbul.jpg' },
            { emoji: '🇬🇧', city: 'Лондон', country: 'Великобритания', image: '/img/destinations/london.jpg' },
            { emoji: '🇦🇪', city: 'Дубай', country: 'ОАЭ', image: '/img/destinations/dubai.jpg' },
            { emoji: '🇹🇭', city: 'Бангкок', country: 'Таиланд', image: '/img/destinations/bangkok.jpg' },
            { emoji: '🇺🇸', city: 'Нью-Йорк', country: 'США', image: '/img/destinations/newyork.jpg' },
            { emoji: '🇵🇹', city: 'Лиссабон', country: 'Португалия', image: '/img/destinations/lisbon.jpg' },
            { emoji: '🇳🇱', city: 'Амстердам', country: 'Нидерланды', image: '/img/destinations/amsterdam.jpg' },
            { emoji: '🇨🇿', city: 'Прага', country: 'Чехия', image: '/img/destinations/prague.jpg' },
            { emoji: '🇸🇬', city: 'Сингапур', country: 'Сингапур', image: '/img/destinations/singapore.jpg' },
            { emoji: '🇬🇷', city: 'Санторини', country: 'Греция', image: '/img/destinations/santorini.jpg' },
        ];
        const russiaPopularDestinations = [
            { emoji: '🇷🇺', city: 'Алтай', country: 'Россия', image: '/img/destinations/altai.jpg' },
            { emoji: '🇷🇺', city: 'Камчатка', country: 'Россия', image: '/img/destinations/kamchatka.jpg' },
            { emoji: '🇷🇺', city: 'Дагестан', country: 'Россия', image: '/img/destinations/dagestan.jpg' },
            { emoji: '🇷🇺', city: 'Суздаль', country: 'Россия', image: '/img/destinations/suzdal.jpg' },
            { emoji: '🇷🇺', city: 'Казань', country: 'Россия', image: '/img/destinations/kazan.jpg' },
            { emoji: '🇷🇺', city: 'Сочи', country: 'Россия', image: '/img/destinations/sochi.jpg' },
            { emoji: '🇷🇺', city: 'Байкал', country: 'Россия', image: '/img/destinations/baikal.jpg' },
            { emoji: '🇷🇺', city: 'Карелия', country: 'Россия', image: '/img/destinations/karelia.jpg' },
            { emoji: '🇷🇺', city: 'Калининград', country: 'Россия', image: '/img/destinations/kaliningrad.jpg' },
            { emoji: '🇷🇺', city: 'Санкт-Петербург', country: 'Россия', image: '/img/destinations/spb.jpg' },
            { emoji: '🇷🇺', city: 'Москва', country: 'Россия', image: '/img/destinations/moscow.jpg' },
            { emoji: '🇷🇺', city: 'Владивосток', country: 'Россия', image: '/img/destinations/vladivostok.jpg' },
            { emoji: '🇷🇺', city: 'Красная Поляна', country: 'Россия', image: '/img/destinations/rosa.jpg' },
            { emoji: '🇷🇺', city: 'Нижний Новгород', country: 'Россия', image: '/img/destinations/nnovgorod.jpg' },
            { emoji: '🇷🇺', city: 'Домбай', country: 'Россия', image: '/img/destinations/dombay.jpg' },
        ];
        let travelRegion = 'world';
        let popularDestinations = [...defaultPopularDestinations];

        // Build reverse city → country index
        const cityToCountryMap = {};
        const allCities = [];
        countriesData.forEach(c => {
            (c.cities || []).forEach(city => {
                const key = city.toLowerCase();
                cityToCountryMap[key] = c;
                allCities.push({ city, country: c });
            });
        });

        function initCountryCitySelectors() {
            const countryInput = document.getElementById('countryInput');
            const cityInput = document.getElementById('cityInput');
            if (!countryInput || !cityInput) return;

            countryInput.addEventListener('focus', () => renderCountrySuggestions(countryInput.value));
            cityInput.addEventListener('focus', () => renderCitySuggestions(cityInput.value));
            
            // Close dropdowns on click outside (replaces unreliable 200ms blur timeout)
            document.addEventListener('pointerdown', (e) => {
                if (!e.target.closest('.s1-ac')) {
                    const cs = document.getElementById('countrySuggestions');
                    const ci = document.getElementById('citySuggestions');
                    if (cs) cs.classList.add('hidden');
                    if (ci) ci.classList.add('hidden');
                }
            });
        }

        function getCountryByInput(value) {
            if (!value) return null;
            const v = value.trim().toLowerCase();
            let exact = countriesData.find(c => c.name.toLowerCase() === v);
            if (exact) return exact;
            return countriesData.find(c => c.name.toLowerCase().startsWith(v)) || null;
        }

        function onCountryInput() {
            const countryInput = document.getElementById('countryInput');
            const cityInput = document.getElementById('cityInput');
            if (!countryInput) return;
            clearInputError('countryInput');
            clearTimeout(_countryDebounce);
            _countryDebounce = setTimeout(() => {
                renderCountrySuggestions(countryInput.value);
                // If city already typed, check if it still matches
                if (cityInput && cityInput.value) {
                    renderCitySuggestions(cityInput.value);
                }
            }, 150);
        }

        // Открывает нативный календарь по клику на всё поле даты
        function openDatePicker(input) {
            if (input && typeof input.showPicker === 'function') {
                try { input.showPicker(); } catch (e) {}
            }
        }

        // ===== DAYS COUNTER PILL =====
        function updateDaysCounter() {
            const startVal = document.getElementById('dateStart')?.value;
            const endVal = document.getElementById('dateEnd')?.value;
            const pill = document.getElementById('daysCounterPill');
            const numEl = document.getElementById('daysCounterNum');
            const textEl = document.getElementById('daysCounterText');
            if (!pill || !numEl || !textEl) return;
            s2ClearAllErrors();
            // Не даём выбрать дату окончания раньше даты начала
            const endInput = document.getElementById('dateEnd');
            if (endInput) endInput.min = startVal || '';
            if (!startVal || !endVal) { pill.classList.remove('visible'); return; }
            const start = new Date(startVal);
            const end = new Date(endVal);
            // diff = разница в сутках; число дней поездки = diff + 1 (включая день начала и день конца)
            const diff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
            if (diff >= 0) {
                const days = diff + 1;
                if (numEl.textContent !== String(days)) {
                    numEl.classList.remove('s2-num-roll');
                    void numEl.offsetWidth;
                    numEl.textContent = days;
                    numEl.classList.add('s2-num-roll');
                }
                if (days === 1) textEl.textContent = 'день';
                else if (days < 5) textEl.textContent = 'дня';
                else textEl.textContent = 'дней';
                pill.classList.add('visible');
            } else {
                pill.classList.remove('visible');
                s2ShowError('.s2-dates-card', 'Дата окончания не может быть раньше даты начала');
            }
        }

        // ===== WISHES CHIPS =====
        function initWishesChips() {
            const chips = document.querySelectorAll('#wishesChips .wishes-chip');
            const input = document.getElementById('wishesInput');
            if (!input) return;
            chips.forEach(chip => {
                chip.addEventListener('click', () => {
                    const text = chip.getAttribute('data-text');
                    if (!text) return;
                    let cur = input.value.trim();
                    if (chip.classList.contains('used')) {
                        cur = cur.split(/,\s*/).filter(s => s.trim() && s.trim() !== text).join(', ');
                        chip.classList.remove('used');
                    } else {
                        if (cur && !cur.endsWith(',')) cur += ', ';
                        cur += text;
                        chip.classList.add('used');
                    }
                    input.value = cur;
                    updateWishesCounter();
                    if (tg?.HapticFeedback) tg.HapticFeedback.selectionChanged();
                    else if (navigator.vibrate) navigator.vibrate(6);
                });
            });
        }

        // ===== DEBOUNCE HELPER =====
        let _countryDebounce = null;
        let _cityDebounce = null;

        function onCityInput() {
            const cityInput = document.getElementById('cityInput');
            const countryInput = document.getElementById('countryInput');
            if (!cityInput) return;
            // Clear validation error on typing
            clearInputError('cityInput');
            const val = cityInput.value.trim().toLowerCase();
            
            // Auto-detect country from city
            if (val.length >= 2) {
                const exactMatch = cityToCountryMap[val];
                if (exactMatch && countryInput) {
                    countryInput.value = exactMatch.name;
                    clearInputError('countryInput');
                }
            }
            // Debounced render
            clearTimeout(_cityDebounce);
            _cityDebounce = setTimeout(() => renderCitySuggestions(cityInput.value), 150);
        }

        function renderCitySuggestions(query) {
            const box = document.getElementById('citySuggestions');
            if (!box) return;
            const q = (query || '').trim().toLowerCase();
            const countryInput = document.getElementById('countryInput');
            const countryVal = countryInput ? countryInput.value.trim().toLowerCase() : '';
            const selectedCountry = getCountryByInput(countryVal);

            let matches;
            if (selectedCountry) {
                // Filter cities of selected country
                matches = selectedCountry.cities
                    .filter(c => !q || c.toLowerCase().startsWith(q))
                    .map(c => ({ city: c, country: selectedCountry }));
            } else {
                // Search all cities
                matches = allCities.filter(item => !q || item.city.toLowerCase().startsWith(q));
            }
            matches = matches.slice(0, 8);
            
            box.innerHTML = '';
            if (q && matches.length === 0) {
                // Show empty state instead of hiding
                box.innerHTML = '<div class="suggestion-empty">Город не найден 🤷</div>';
                box.classList.remove('hidden');
                return;
            }
            if (!q && matches.length === 0) {
                box.classList.add('hidden');
                return;
            }
            matches.forEach(item => {
                const el = document.createElement('div');
                el.className = 'suggestion-item';
                el.innerHTML = `<span>${item.city}</span><span style="color:var(--text-muted); font-size:12px; margin-left:6px;">${item.country.flag} ${item.country.name}</span>`;
                el.onpointerdown = (e) => {
                    e.preventDefault(); // prevent blur before selection
                    const ci = document.getElementById('cityInput');
                    const co = document.getElementById('countryInput');
                    if (ci) ci.value = item.city;
                    if (co) co.value = item.country.name;
                    box.classList.add('hidden');
                    clearInputError('cityInput');
                    clearInputError('countryInput');
                    updateMainButton();
                    // Haptic feedback
                    if (tg?.HapticFeedback) tg.HapticFeedback.selectionChanged();
                };
                box.appendChild(el);
            });
            box.classList.remove('hidden');
        }

        function renderCountrySuggestions(query) {
            const box = document.getElementById('countrySuggestions');
            if (!box) return;
            const q = (query || '').trim().toLowerCase();
            const matches = countriesData.filter(c => c.name.toLowerCase().startsWith(q)).slice(0, 8);
            box.innerHTML = '';
            if (q && matches.length === 0) {
                box.innerHTML = '<div class="suggestion-empty">Страна не найдена 🤷</div>';
                box.classList.remove('hidden');
                return;
            }
            if (!q || matches.length === 0) {
                box.classList.add('hidden');
                return;
            }
            matches.forEach(c => {
                const item = document.createElement('div');
                item.className = 'suggestion-item';
                item.textContent = `${c.flag} ${c.name}`;
                item.onpointerdown = (e) => {
                    e.preventDefault(); // prevent blur before selection
                    const input = document.getElementById('countryInput');
                    const cityInput = document.getElementById('cityInput');
                    if (input) input.value = c.name;
                    box.classList.add('hidden');
                    clearInputError('countryInput');
                    updateMainButton();
                    // Focus city input after selecting country
                    if (cityInput) {
                        cityInput.value = '';
                        setTimeout(() => cityInput.focus(), 100);
                    }
                    // Haptic feedback
                    if (tg?.HapticFeedback) tg.HapticFeedback.selectionChanged();
                };
                box.appendChild(item);
            });
            box.classList.remove('hidden');
        }

        function setTripMode(mode) {
            tripMode = mode;
            const datesBlock = document.getElementById('tripDatesBlock');
            const daysBlock = document.getElementById('tripDaysBlock');
            const toggle = document.getElementById('s2ModeToggle');
            if (toggle) toggle.setAttribute('data-mode', mode);
            // Update toggle buttons
            document.querySelectorAll('#step2 .s2-mode-btn').forEach(b => b.classList.remove('selected'));
            const activeBtn = document.querySelector(`#step2 .s2-mode-btn[data-mode='${mode}']`);
            if (activeBtn) activeBtn.classList.add('selected');
            if (datesBlock && daysBlock) {
                if (mode === 'days') {
                    datesBlock.classList.add('hidden');
                    daysBlock.classList.remove('hidden');
                } else {
                    daysBlock.classList.add('hidden');
                    datesBlock.classList.remove('hidden');
                }
            }
        }

        // ===== MULTI-SELECT TRIP TYPES =====
        let selectedTripTypes = [];

        function toggleTripType(btn, value) {
            const idx = selectedTripTypes.indexOf(value);
            // Ripple — всегда
            const evt = (window.event && window.event.clientX !== undefined) ? window.event : null;
            const r = btn.getBoundingClientRect();
            const size = Math.max(r.width, r.height);
            const ripple = document.createElement('span');
            ripple.className = 'tt-ripple';
            const rx = evt ? evt.clientX - r.left : r.width / 2;
            const ry = evt ? evt.clientY - r.top  : r.height / 2;
            ripple.style.width = ripple.style.height = size + 'px';
            ripple.style.left = (rx - size / 2) + 'px';
            ripple.style.top  = (ry - size / 2) + 'px';
            btn.appendChild(ripple);
            setTimeout(() => ripple.remove(), 700);

            if (idx >= 0) {
                // Deselect
                selectedTripTypes.splice(idx, 1);
                btn.classList.remove('selected');
            } else {
                // Sparkle при выборе
                for (let i = 0; i < 6; i++) {
                    const s = document.createElement('span');
                    s.className = 'tt-sparkle';
                    s.style.left = (r.width / 2) + 'px';
                    s.style.top  = '22px';
                    const angle = (Math.PI * 2 * i) / 6 + (Math.random() - 0.5) * 0.6;
                    const dist  = 28 + Math.random() * 14;
                    s.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
                    s.style.setProperty('--dy', Math.sin(angle) * dist + 'px');
                    s.style.animationDelay = (i * 18) + 'ms';
                    btn.appendChild(s);
                    setTimeout(() => s.remove(), 800);
                }
                // Max 4 types
                if (selectedTripTypes.length >= 4) {
                    // Remove oldest selection
                    const oldVal = selectedTripTypes.shift();
                    document.querySelectorAll('#step2 .triptype-button').forEach(b => {
                        if (b.onclick.toString().includes(oldVal) || b.dataset.type === oldVal) {
                            b.classList.remove('selected');
                        }
                    });
                    // Find by matching — more reliable
                    document.querySelectorAll('#step2 .triptype-button.selected').forEach((b, i) => {
                        // We just need to keep only the ones in selectedTripTypes
                    });
                }
                selectedTripTypes.push(value);
                btn.classList.add('selected');
            }
            // Update tripData
            tripData.tripType = selectedTripTypes.join(' + ');
            tripData.tripTypes = [...selectedTripTypes];
            
            // Update counter badge
            const countEl = document.getElementById('selectedTypesCount');
            if (countEl) {
                countEl.innerHTML = selectedTripTypes.length > 0
                    ? `<span class="selected-count">${selectedTripTypes.length}</span>`
                    : '';
            }
            
            // Re-sync button states
            document.querySelectorAll('#step2 .triptype-button').forEach(b => {
                // Extract value from onclick text
                const match = b.getAttribute('onclick')?.match(/toggleTripType\(this,\s*'([^']+)'\)/);
                if (match) {
                    b.classList.toggle('selected', selectedTripTypes.includes(match[1]));
                }
            });
            // Clear validation error on type selection
            s2ClearAllErrors();
            // Haptic feedback
            if (tg?.HapticFeedback) tg.HapticFeedback.selectionChanged();
        }

        function updateWishesCounter() {
            const textarea = document.getElementById('wishesInput');
            const counter = document.getElementById('wishesCounter');
            if (!textarea || !counter) return;
            const len = textarea.value.length;
            counter.textContent = `${len} / 300`;
            counter.classList.toggle('over', len >= 280);
            // Sync chip "used" states
            const text = textarea.value;
            document.querySelectorAll('#wishesChips .wishes-chip').forEach(chip => {
                const t = chip.getAttribute('data-text');
                chip.classList.toggle('used', t && text.includes(t));
            });
        }

        // ===== SCROLL INPUT INTO VIEW (mobile only, above iOS keyboard) =====
        const _isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || ('ontouchstart' in window && window.innerWidth < 768);
        let _sfivAnim = null;
        
        function scrollFieldIntoView(el) {
            // Only run on mobile devices — desktop doesn't need this
            if (!_isMobile) return;
            // Cancel any ongoing scroll animation
            if (_sfivAnim) { cancelAnimationFrame(_sfivAnim); _sfivAnim = null; }
            
            // Wait for keyboard to fully open, then do ONE smooth scroll
            const startScroll = () => {
                const rect = el.getBoundingClientRect();
                const vv = window.visualViewport;
                const viewH = vv ? vv.height : window.innerHeight;
                const viewTop = vv ? vv.offsetTop : 0;
                
                // Target: field at 30% from top of visible area
                const targetY = viewTop + viewH * 0.30;
                const totalDiff = rect.top - targetY;
                
                if (Math.abs(totalDiff) < 5) return;
                
                // Manual smooth scroll with easeOutCubic
                const startPos = window.scrollY;
                const endPos = startPos + totalDiff;
                const duration = 400; // ms
                const startTime = performance.now();
                
                const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
                
                const animate = (now) => {
                    const elapsed = now - startTime;
                    const progress = Math.min(elapsed / duration, 1);
                    const eased = easeOutCubic(progress);
                    
                    window.scrollTo(0, startPos + totalDiff * eased);
                    
                    if (progress < 1) {
                        _sfivAnim = requestAnimationFrame(animate);
                    } else {
                        _sfivAnim = null;
                    }
                };
                
                _sfivAnim = requestAnimationFrame(animate);
            };
            
            // Single delayed call: wait for iOS keyboard to appear (~500ms)
            // + listen for visualViewport resize as the reliable signal
            let fired = false;
            const fireOnce = () => {
                if (fired) return;
                fired = true;
                startScroll();
            };
            
            // Fallback timer in case visualViewport event doesn't fire (desktop, etc.)
            const timer = setTimeout(fireOnce, 500);
            
            if (window.visualViewport) {
                const onResize = () => {
                    window.visualViewport.removeEventListener('resize', onResize);
                    clearTimeout(timer);
                    // Small extra delay for keyboard to settle
                    setTimeout(fireOnce, 80);
                };
                window.visualViewport.addEventListener('resize', onResize, { once: true });
            }
        }

        // ===== DONE BUTTON (keyboard dismiss for mobile / iOS) =====
        let _doneBarTarget = null;

        function dismissKeyboard() {
            _doneBarTarget = null;
            document.activeElement?.blur();
            const doneBar = document.getElementById('inputDoneBar');
            if (doneBar) {
                doneBar.classList.remove('visible');
                doneBar.style.transform = '';
            }
        }

        // Position the bar right above the iOS keyboard using visualViewport
        function _repositionDoneBar() {
            const doneBar = document.getElementById('inputDoneBar');
            if (!doneBar || !doneBar.classList.contains('visible')) return;
            
            if (window.visualViewport) {
                const vv = window.visualViewport;
                // Place bar at the bottom of the visual viewport (= above keyboard)
                const bottomOffset = window.innerHeight - (vv.offsetTop + vv.height);
                doneBar.style.bottom = bottomOffset + 'px';
            }
        }

        // Show/hide "Готово" bar when focusing/blurring inputs
        (function initDoneButton() {
            // Only on mobile devices
            if (!_isMobile) return;
            
            const doneBar = document.getElementById('inputDoneBar');
            if (!doneBar) return;
            const targetSelectors = 'input[type="text"], input[type="number"], input[type="tel"], textarea';
            
            // Use visualViewport events for iOS keyboard tracking
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', _repositionDoneBar);
                window.visualViewport.addEventListener('scroll', _repositionDoneBar);
            }

            document.addEventListener('focusin', (e) => {
                // Only show for actual text/number input fields, not buttons/selects
                // Exclude step1 autocomplete inputs (country/city) — they have their own workflow
                if (e.target.matches(targetSelectors) && !e.target.closest('#step1')) {
                    _doneBarTarget = e.target;
                    doneBar.classList.add('visible');
                    // Small delay to let iOS keyboard animate in
                    setTimeout(_repositionDoneBar, 100);
                    setTimeout(_repositionDoneBar, 300);
                }
            });
            document.addEventListener('focusout', (e) => {
                // Small delay to avoid flicker when tapping the "Готово" button itself
                setTimeout(() => {
                    const active = document.activeElement;
                    if (!active || !active.matches(targetSelectors)) {
                        _doneBarTarget = null;
                        doneBar.classList.remove('visible');
                        doneBar.style.bottom = '0px';
                    }
                }, 120);
            });
        })();

        // ===== Populate wishes panel in results =====
        function showWishesBanner() {
            const panel = document.getElementById('wishesPanelContent');
            if (!panel) return;
            
            const wishes = (tripData.wishes || '').trim();
            const themes = tripData.tripTypes || [];
            const dest = tripData.destination || '';
            
            if (!wishes) {
                // No wishes — show empty state with themes info
                panel.innerHTML = `
                    <div class="wishes-empty">
                        <div class="we-icon">🗺</div>
                        <div class="we-title">Пожеланий не было</div>
                        <div class="we-desc">В следующий раз вы можете написать пожелания на этапе выбора маршрута — мы учтём их при подборе.</div>
                    </div>
                `;
                return;
            }
            
            // Build themed suggestions
            let howItems = '';
            
            // 1. Places from wishes
            howItems += `
                <div class="wishes-how-item">
                    <div class="whi-icon">📍</div>
                    <div class="whi-body">
                        <div class="whi-title">Места в маршруте</div>
                        <div class="whi-desc">Мы включили ваши пожелания в маршрут по дням. Если вас заинтересовало конкретное место — найдите его на карте выше, выбрав нужный день.</div>
                    </div>
                </div>`;
            
            // 2. Hotels suggestion
            howItems += `
                <div class="wishes-how-item">
                    <div class="whi-icon">🏨</div>
                    <div class="whi-body">
                        <div class="whi-title">Отели под ваш запрос</div>
                        <div class="whi-desc">Перейдите во вкладку 🎫 Билеты — там подобраны отели в ${dest}, подходящие под ваш бюджет.</div>
                    </div>
                </div>`;
            
            // 3. Budget
            howItems += `
                <div class="wishes-how-item">
                    <div class="whi-icon">💰</div>
                    <div class="whi-body">
                        <div class="whi-title">Бюджет с учётом пожеланий</div>
                        <div class="whi-desc">Раскладка по дням во вкладке 💰 Бюджет учитывает ваши предпочтения и выбранные темы.</div>
                    </div>
                </div>`;
            
            // 4. Tips
            howItems += `
                <div class="wishes-how-item">
                    <div class="whi-icon">💡</div>
                    <div class="whi-body">
                        <div class="whi-title">Советы под вас</div>
                        <div class="whi-desc">Во вкладке 💡 Советы — лайфхаки для ${dest}, подобранные с учётом ваших тем: ${themes.join(', ') || 'общий маршрут'}.</div>
                    </div>
                </div>`;
            
            panel.innerHTML = `
                <div class="wishes-panel-header">
                    <div class="wp-icon">🎯</div>
                    <div>
                        <div class="wp-title">Ваши пожелания учтены</div>
                        <div class="wp-sub">Маршрут составлен с учётом вашего запроса</div>
                    </div>
                </div>
                
                <div class="wishes-quote">
                    <div class="wq-label">Вы написали</div>
                    <div class="wq-text">«${wishes}»</div>
                </div>
                
                <div class="wishes-how">
                    <div class="wishes-how-title">Как мы это учли:</div>
                    ${howItems}
                </div>
            `;
        }

        let currentStep = 1;

        function updateStepIndicator(step) {
            // Update progress bar fill
            const fill = document.getElementById('stepProgressFill');
            if (fill) {
                const pct = (step / 3) * 100;
                fill.style.width = pct + '%';
            }
            // Update header step label
            const label = document.getElementById('headerStepLabel');
            if (label) label.textContent = 'Шаг ' + step + ' из 3';
            // Legacy circle/line updates (kept for compat)
            for (let i = 1; i <= 3; i++) {
                const circle = document.getElementById('stepCircle' + i);
                if (!circle) continue;
                circle.classList.remove('active', 'done', 'future');
                if (i < step) {
                    circle.classList.add('done');
                } else if (i === step) {
                    circle.classList.add('active');
                } else {
                    circle.classList.add('future');
                }
            }
            for (let i = 1; i <= 2; i++) {
                const line = document.getElementById('stepLine' + i);
                if (!line) continue;
                line.classList.toggle('done', i < step);
            }
        }

        function animateStepTransition(fromStep, toStep, direction) {
            const fromEl = document.getElementById('step' + fromStep);
            const toEl = document.getElementById('step' + toStep);
            if (!fromEl || !toEl) return;

            fromEl.classList.add('hidden');
            fromEl.style.animation = '';
            toEl.classList.remove('hidden');
            toEl.style.animation = direction === 'forward'
                ? 'stepSlideIn 0.22s ease-out forwards'
                : 'stepSlideInLeft 0.22s ease-out forwards';
            setTimeout(() => { toEl.style.animation = ''; }, 240);

            updateStepIndicator(toStep);
            currentStep = toStep;
            if (toStep === 1) {
                if (typeof s1MaybePulseCta === 'function') s1MaybePulseCta();
            } else {
                if (typeof s1ResetCtaFixed === 'function') s1ResetCtaFixed();
            }
            window.scrollTo({ top: 0, behavior: 'auto' });
        }

        function goBack(toStep) {
            animateStepTransition(currentStep, toStep, 'backward');
            // Update MainButton for the target step
            updateMainButtonForStep(toStep);
        }

        function selectPopularDest(el) {
            document.querySelectorAll('.popular-chip, .s1-city-card').forEach(c => {
                c.classList.remove('selected', 's1-selected');
            });
            el.classList.add(el.classList.contains('s1-city-card') ? 's1-selected' : 'selected');
            const city = el.getAttribute('data-city');
            let country = el.getAttribute('data-country');
            const flag = el.getAttribute('data-flag') || '🌍';
            if (!country && city) {
                const found = cityToCountryMap[city.toLowerCase()];
                if (found) country = found.name;
            }
            const cityInput = document.getElementById('cityInput');
            const countryInput = document.getElementById('countryInput');
            if (countryInput) countryInput.value = country || '';
            if (cityInput) cityInput.value = city;
            // Update unified search input + chip
            const uni = document.getElementById('unifiedSearchInput');
            if (uni && city && country) {
                uni.value = `${city}, ${country}`;
                const wrap = uni.closest('.s1-unified-wrap');
                if (wrap) wrap.classList.add('has-value');
            }
            showSelectedChip(city, country, flag);
            // Hide dropdowns
            const cs = document.getElementById('countrySuggestions');
            const ci = document.getElementById('citySuggestions');
            const ui = document.getElementById('unifiedSuggestions');
            if (cs) cs.classList.add('hidden');
            if (ci) ci.classList.add('hidden');
            if (ui) ui.classList.add('hidden');
            clearInputError('countryInput');
            clearInputError('cityInput');
            updateMainButton();
            if (tg?.HapticFeedback) tg.HapticFeedback.selectionChanged();
            else if (navigator.vibrate) navigator.vibrate(8);
        }

        // City image fallback map for destinations without images (high quality)
        const cityImageMap = {
            'абу-даби': 'https://images.unsplash.com/photo-1512632578888-169bbbc64f33?w=800&q=85&auto=format&fit=crop',
            'абуджа': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9c/Abuja_Collage.jpg/960px-Abuja_Collage.jpg',
            'агра': 'https://upload.wikimedia.org/wikipedia/commons/6/68/Taj_Mahal%2C_Agra%2C_India.jpg',
            'аддис-абеба': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Addis_in_night.jpg/960px-Addis_in_night.jpg',
            'аделаида': 'https://upload.wikimedia.org/wikipedia/commons/d/d6/Adelaide%27s_updated_montage.jpg',
            'аджман': 'https://images.unsplash.com/photo-1576487248805-cf45f6bcc67f?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlOTAlRDAlQjQlRDAlQjYlRDAlQkMlRDAlQjAlRDAlQkQlMjAlRDAlOUUlRDAlOTAlRDAlQUQlMjB0cmF2ZWwlMjBsYW5kbWFyayUyMGRlc3RpbmF0aW9ufGVufDF8MHx8fDE3Nzg3NTA5MzB8MA&ixlib=rb-4.1.0&q=80&w=400',
            'аккра': 'https://upload.wikimedia.org/wikipedia/commons/a/af/Accra_montage.jpg',
            'акюрейри': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/2014-04-30_14-09-41_Iceland_-_Akureyri_Akureyri.jpg/960px-2014-04-30_14-09-41_Iceland_-_Akureyri_Akureyri.jpg',
            'алматы': 'https://images.unsplash.com/photo-1562008929-4dda1f5cb398?w=800&q=85&auto=format&fit=crop',
            'амстердам': '/img/destinations/amsterdam.jpg',
            'анкара': 'https://upload.wikimedia.org/wikipedia/commons/0/04/Ankara_Montage_2020.jpg',
            'анталья': 'https://images.unsplash.com/photo-1590523741831-ab7e8b8f9c7f?w=800&q=85&auto=format&fit=crop',
            'антверпен': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Royal_Museum_of_Fine_Arts_Antwerp_3.jpg/800px-Royal_Museum_of_Fine_Arts_Antwerp_3.jpg',
            'арекипа': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/62/80_-_Machu_Picchu_-_Juin_2009_-_edit.jpg/960px-80_-_Machu_Picchu_-_Juin_2009_-_edit.jpg',
            'аруша': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0e/Arusha_City_view.jpg/3840px-Arusha_City_view.jpg',
            'астана': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/ce/Astana_DSC04362_%287711355642%29.jpg/3840px-Astana_DSC04362_%287711355642%29.jpg',
            'афины': 'https://images.unsplash.com/photo-1555993539-1732b0258235?w=800&q=85&auto=format&fit=crop',
            'баку': 'https://images.unsplash.com/photo-1609177484694-d5530eeef150?w=800&q=85&auto=format&fit=crop',
            'бали': '/img/destinations/bali.jpg',
            'бангкок': '/img/destinations/bangkok.jpg',
            'баньос': 'https://upload.wikimedia.org/wikipedia/commons/e/e9/Banos.jpg',
            'баня-лука': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/NKD115_Saborna_crkva_Hrista_spasitelja_Banja_Luka_RS_BiH.jpg/960px-NKD115_Saborna_crkva_Hrista_spasitelja_Banja_Luka_RS_BiH.jpg',
            'бар': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Coat_of_Arms_of_Bar_Montenegro.svg/800px-Coat_of_Arms_of_Bar_Montenegro.svg.png',
            'барилоче': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bb/Centro_C%C3%ADvico_y_Puerto_San_Carlos_en_Bariloche.jpg/960px-Centro_C%C3%ADvico_y_Puerto_San_Carlos_en_Bariloche.jpg',
            'барселона': '/img/destinations/barcelona.jpg',
            'баттамбанг': 'https://upload.wikimedia.org/wikipedia/commons/4/46/Battambangcart.jpg',
            'батуми': 'https://images.unsplash.com/photo-1574863735543-9ea2b3148a64?w=800&q=85&auto=format&fit=crop',
            'белград': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/24/Flag_of_Belgrade%2C_Serbia.svg/langru-500px-Flag_of_Belgrade%2C_Serbia.svg.png',
            'берат': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/Berat_57.jpg/3840px-Berat_57.jpg',
            'берген': 'https://upload.wikimedia.org/wikipedia/commons/1/1a/BergenCityHallMay17.jpg',
            'берлин': 'https://images.unsplash.com/photo-1560969184-10fe8719e047?w=800&q=85&auto=format&fit=crop',
            'берн': 'https://images.unsplash.com/photo-1603989713458-b7ec73616c17?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlOTElRDAlQjUlRDElODAlRDAlQkQlMjAlRDAlQTglRDAlQjIlRDAlQjUlRDAlQjklRDElODYlRDAlQjAlRDElODAlRDAlQjglRDElOEYlMjB0cmF2ZWwlMjBsYW5kbWFyayUyMGRlc3RpbmF0aW9ufGVufDF8MHx8fDE3Nzg3NTA5NjR8MA&ixlib=rb-4.1.0&q=80&w=400',
            'биллунн': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8f/Billund_skyline.jpg/3840px-Billund_skyline.jpg',
            'блед': 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3c/4260_Bled%2C_Slovenia_-_panoramio.jpg/800px-4260_Bled%2C_Slovenia_-_panoramio.jpg',
            'богота': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/20/Bogota%2C_Colombia_%2836668708290%29.jpg/960px-Bogota%2C_Colombia_%2836668708290%29.jpg',
            'бодрум': 'https://images.unsplash.com/photo-1568702846914-96b305d2aaeb?w=800&q=85&auto=format&fit=crop',
            'боракай': 'https://upload.wikimedia.org/wikipedia/commons/5/5e/Borakay_Kurds_in_Baghdad%2C_1950.png',
            'бордо': 'https://images.unsplash.com/photo-1632584063437-b83388122ed2?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlOTElRDAlQkUlRDElODAlRDAlQjQlRDAlQkUlMjAlRDAlQTQlRDElODAlRDAlQjAlRDAlQkQlRDElODYlRDAlQjglRDElOEYlMjB0cmF2ZWwlMjBsYW5kbWFyayUyMGRlc3RpbmF0aW9ufGVufDF8MHx8fDE3Nzg3NTA5MjZ8MA&ixlib=rb-4.1.0&q=80&w=400',
            'брага': 'https://images.unsplash.com/photo-1531772337062-9d94547f333f?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlOTElRDElODAlRDAlQjAlRDAlQjMlRDAlQjAlMjAlRDAlOUYlRDAlQkUlRDElODAlRDElODIlRDElODMlRDAlQjMlRDAlQjAlRDAlQkIlRDAlQjglRDElOEYlMjB0cmF2ZWwlMjBsYW5kbWFyayUyMGRlc3RpbmF0aW9ufGVufDF8MHx8fDE3Nzg3NTA5NTF8MA&ixlib=rb-4.1.0&q=80&w=400',
            'бразилиа': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6f/20050114_015.jpg/960px-20050114_015.jpg',
            'братислава': 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/Slovakia_bratislava.jpg/3840px-Slovakia_bratislava.jpg',
            'бристоль': 'https://upload.wikimedia.org/wikipedia/commons/f/f7/Bristol_landmarks_collage.png',
            'брно': 'https://upload.wikimedia.org/wikipedia/commons/d/d4/Brno_Montage_III.jpg',
            'брюгге': 'https://upload.wikimedia.org/wikipedia/commons/8/83/Views_of_Onze-Lieve-Vrouwekerk_%28Brugge%29_1.jpg',
            'брюссель': 'https://images.unsplash.com/photo-1559113202-c916b8e44373?w=800&q=85&auto=format&fit=crop',
            'будапешт': 'https://images.unsplash.com/photo-1541849546-216549ae216d?w=800&q=85&auto=format&fit=crop',
            'буэнос-айрес': 'https://images.unsplash.com/photo-1589909202802-8f4aadce1849?w=800&q=85&auto=format&fit=crop',
            'валенсия': 'https://upload.wikimedia.org/wikipedia/commons/e/e3/Collage_de_la_ciudad_de_Valencia%2C_capital_de_la_Comunidad_Valenciana%2C_Espa%C3%B1a.png',
            'валлетта': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b7/St_Sebastian_Curtain_%28cropped%29.jpg/3840px-St_Sebastian_Curtain_%28cropped%29.jpg',
            'вальпараисо': 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/32/Ascensor_Artiller%C3%ADa.jpg/960px-Ascensor_Artiller%C3%ADa.jpg',
            'ванкувер': 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/11/Vancouver_Montage_2020.jpg/960px-Vancouver_Montage_2020.jpg',
            'варадеро': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9c/Varadero_-_Cuba_%2841007616331%29.jpg/800px-Varadero_-_Cuba_%2841007616331%29.jpg',
            'варна': 'https://upload.wikimedia.org/wikipedia/commons/3/3c/Varna-Collage-TB.jpg',
            'варшава': 'https://images.unsplash.com/photo-1519197924294-4ba991a11128?w=800&q=85&auto=format&fit=crop',
            'вена': 'https://images.unsplash.com/photo-1516550893923-42d28e5677af?w=800&q=85&auto=format&fit=crop',
            'венеция': 'https://images.unsplash.com/photo-1523906834658-6e24ef2386f9?w=800&q=85&auto=format&fit=crop',
            'вик': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6f/Iceland-Vik-Oct2009.jpg/960px-Iceland-Vik-Oct2009.jpg',
            'вильнюс': 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4f/Bernardinerkirche_Vilnius_1.jpg/960px-Bernardinerkirche_Vilnius_1.jpg',
            'виндхук': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Windhoek-Skyline.jpg/800px-Windhoek-Skyline.jpg',
            'винья-дель-мар': 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4b/Castillo_Wulff1.JPG/960px-Castillo_Wulff1.JPG',
            'владивосток': '/img/destinations/vladivostok.jpg',
            'вроцлав': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/Wroclaw-Rathaus.jpg/800px-Wroclaw-Rathaus.jpg',
            'гаага': 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cityscape_of_The_Hague%2C_viewed_from_Het_Plein_%28The_Square%29.jpg/800px-Cityscape_of_The_Hague%2C_viewed_from_Het_Plein_%28The_Square%29.jpg',
            'гавана': 'https://images.unsplash.com/photo-1500759285222-a95626b934cb?w=800&q=85&auto=format&fit=crop',
            'галапагос': 'https://upload.wikimedia.org/wikipedia/ru/6/67/%D0%93%D0%B0%D0%BB%D0%B0%D0%BF%D0%B0%D0%B3%D0%BE%D1%81.png',
            'гамбург': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Hamburg_montage.jpg/800px-Hamburg_montage.jpg',
            'гвадалахара': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/Guadalajara%2C_PH.jpg/960px-Guadalajara%2C_PH.jpg',
            'гданьск': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/81/Calle_Dlugie_Pobrzeze%2C_Gdansk%2C_Polonia%2C_2013-05-20%2C_DD_06.jpg/3840px-Calle_Dlugie_Pobrzeze%2C_Gdansk%2C_Polonia%2C_2013-05-20%2C_DD_06.jpg',
            'гент': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/60/1007_Graslei%2C_Clock_tower_of_the_Post_Office%2C_Church_of_Saint-Nicolas_in_Ghent_and_Belfry_of_Ghent_Photo_by_Giles_Laurent.jpg/800px-1007_Graslei%2C_Clock_tower_of_the_Post_Office%2C_Church_of_Saint-Nicolas_in_Ghent_and_Belfry_of_Ghent_Photo_by_Giles_Laurent.jpg',
            'гоа': 'https://images.unsplash.com/photo-1512343879784-a960bf40e7f2?w=800&q=85&auto=format&fit=crop',
            'гозо': 'https://upload.wikimedia.org/wikipedia/commons/b/b9/Gozo_from_space_via_laser_ESA378503_%28cropped%29.jpg',
            'голуэй': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0a/Galwaycitycollage.jpg/960px-Galwaycitycollage.jpg',
            'гомель': 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/%D0%9F%D0%B0%D0%BB%D0%B0%D1%86%D0%B0%D0%B2%D0%B0-%D0%BF%D0%B0%D1%80%D0%BA%D0%B0%D0%B2%D1%8B_%D0%BA%D0%BE%D0%BC%D0%BF%D0%BB%D0%B5%D0%BA%D1%81_%D1%9E_%D0%93%D0%BE%D0%BC%D0%B5%D0%BB%D1%96._%D0%A1%D0%B0%D0%B1%D0%BE%D1%80_%D1%96_%D0%BA%D0%B0%D0%BF%D0%BB%D1%96%D1%86%D0%B0.jpg/960px-%D0%9F%D0%B0%D0%BB%D0%B0%D1%86%D0%B0%D0%B2%D0%B0-%D0%BF%D0%B0%D1%80%D0%BA%D0%B0%D0%B2%D1%8B_%D0%BA%D0%BE%D0%BC%D0%BF%D0%BB%D0%B5%D0%BA%D1%81_%D1%9E_%D0%93%D0%BE%D0%BC%D0%B5%D0%BB%D1%96._%D0%A1%D0%B0%D0%B1%D0%BE%D1%80_%D1%96_%D0%BA%D0%B0%D0%BF%D0%BB%D1%96%D1%86%D0%B0.jpg',
            'гонконг': 'https://images.unsplash.com/photo-1536599018102-9f803c979b13?w=800&q=85&auto=format&fit=crop',
            'грац': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Graz_View_from_Schlossberg-2464.jpg/800px-Graz_View_from_Schlossberg-2464.jpg',
            'гродно': 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/32/Horadnia_%28Hrodna%29%2C_Vilienskaja._%D0%93%D0%BE%D1%80%D0%B0%D0%B4%D0%BD%D1%8F%2C_%D0%92%D1%96%D0%BB%D0%B5%D0%BD%D1%81%D0%BA%D0%B0%D1%8F_%282021%29_05.jpg/960px-Horadnia_%28Hrodna%29%2C_Vilienskaja._%D0%93%D0%BE%D1%80%D0%B0%D0%B4%D0%BD%D1%8F%2C_%D0%92%D1%96%D0%BB%D0%B5%D0%BD%D1%81%D0%BA%D0%B0%D1%8F_%282021%29_05.jpg',
            'гуанчжоу': 'https://upload.wikimedia.org/wikipedia/commons/d/df/Guangzhou_montage.jpg',
            'гётеборг': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/G%C3%B6teborg_2503_stitch_%2828573994096%29.jpg/800px-G%C3%B6teborg_2503_stitch_%2828573994096%29.jpg',
            'давао': 'https://upload.wikimedia.org/wikipedia/commons/0/08/Victoria_Plaza_Davao.JPG',
            'давид': 'https://upload.wikimedia.org/wikipedia/commons/9/94/King_David%2C_the_King_of_Israel.jpg',
            'дар-эс-салам': 'https://upload.wikimedia.org/wikipedia/commons/e/e1/View_of_Panton_and_Dar_es_salaam_City_%28City_center%29.jpg',
            'даугавпилс': 'https://upload.wikimedia.org/wikipedia/commons/8/8e/How_Daugavpils_look_like.jpg',
            'дебрецен': 'https://upload.wikimedia.org/wikipedia/commons/0/05/Universit%C3%A4t_Debrecen_Nr._3.jpg',
            'дели': 'https://images.unsplash.com/photo-1587474260584-136574528ed5?w=800&q=85&auto=format&fit=crop',
            'джакарта': 'https://upload.wikimedia.org/wikipedia/commons/9/98/Jakarta.jpg',
            'джераш': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Jerash_City.jpg/3840px-Jerash_City.jpg',
            'джинджя': 'https://upload.wikimedia.org/wikipedia/commons/b/b8/KampalaSkyln.jpg',
            'джокьякарта': 'https://upload.wikimedia.org/wikipedia/commons/5/54/Montage_of_Yogyakarta.jpg',
            'дикирх': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/08/Diekirch%2C_H%C3%B4tel_de_ville_%28101%29.jpg/960px-Diekirch%2C_H%C3%B4tel_de_ville_%28101%29.jpg',
            'доманьяно': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6e/DomagnanoBorgoMaggioreRSMPanorama.JPG/800px-DomagnanoBorgoMaggioreRSMPanorama.JPG',
            'дубай': '/img/destinations/dubai.jpg',
            'дублин': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/92/Dublin_-_aerial_-_2025-07-07_01.jpg/3840px-Dublin_-_aerial_-_2025-07-07_01.jpg',
            'дубровник': 'https://images.unsplash.com/photo-1555990538-1e2a6c6f7ec2?w=800&q=85&auto=format&fit=crop',
            'ереван': 'https://images.unsplash.com/photo-1558015336-e3a15d558b05?w=800&q=85&auto=format&fit=crop',
            'женева': 'https://images.unsplash.com/photo-1603989713458-b7ec73616c17?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlOTYlRDAlQjUlRDAlQkQlRDAlQjUlRDAlQjIlRDAlQjAlMjAlRDAlQTglRDAlQjIlRDAlQjUlRDAlQjklRDElODYlRDAlQjAlRDElODAlRDAlQjglRDElOEYlMjB0cmF2ZWwlMjBsYW5kbWFyayUyMGRlc3RpbmF0aW9ufGVufDF8MHx8fDE3Nzg3NTA5NjR8MA&ixlib=rb-4.1.0&q=80&w=400',
            'загреб': 'https://upload.wikimedia.org/wikipedia/commons/4/46/Montage_of_major_Zagreb_landmarks.jpg',
            'задар': 'https://upload.wikimedia.org/wikipedia/commons/5/53/View_from_Bell_Tower%2C_Zadar%2C_Croatia.jpg',
            'зальцбург': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/Salzburg_%2848489551981%29.jpg/800px-Salzburg_%2848489551981%29.jpg',
            'занзибар': 'https://images.unsplash.com/photo-1548550023-2bdb3c5beed7?w=800&q=85&auto=format&fit=crop',
            'измир': 'https://images.unsplash.com/photo-1669656474979-e3a9e26e73c7?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlOTglRDAlQjclRDAlQkMlRDAlQjglRDElODAlMjAlRDAlQTIlRDElODMlRDElODAlRDElODYlRDAlQjglRDElOEYlMjB0cmF2ZWwlMjBsYW5kbWFyayUyMGRlc3RpbmF0aW9ufGVufDF8MHx8fDE3Nzg3NTA5Mjh8MA&ixlib=rb-4.1.0&q=80&w=400',
            'инсбрук': 'https://upload.wikimedia.org/wikipedia/commons/7/7d/Spitalskirche_zum_hl._Geist.jpg',
            'инчхон': 'https://upload.wikimedia.org/wikipedia/commons/f/f7/Incheon_montage_2015.PNG',
            'ираклион': 'https://images.unsplash.com/photo-1603565816030-6b389eeb23cb?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlOTglRDElODAlRDAlQjAlRDAlQkElRDAlQkIlRDAlQjglRDAlQkUlRDAlQkQlMjAlRDAlOTMlRDElODAlRDAlQjUlRDElODYlRDAlQjglRDElOEYlMjB0cmF2ZWwlMjBsYW5kbWFyayUyMGRlc3RpbmF0aW9ufGVufDF8MHx8fDE3Nzg3NTA5NTR8MA&ixlib=rb-4.1.0&q=80&w=400',
            'йокогама': 'https://upload.wikimedia.org/wikipedia/commons/6/69/Japan_Yokohama.png',
            'казань': '/img/destinations/kazan.jpg',
            'каир': 'https://images.unsplash.com/photo-1572252009286-268acec5ca0a?w=800&q=85&auto=format&fit=crop',
            'калгари': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5a/Calgarymontage5.jpg/960px-Calgarymontage5.jpg',
            'кали': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/89/Kali_by_Raja_Ravi_Varma.jpg/960px-Kali_by_Raja_Ravi_Varma.jpg',
            'кампот': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/64/2016_Kampot%2C_Budynek_ze_sklepami.jpg/3840px-2016_Kampot%2C_Budynek_ze_sklepami.jpg',
            'канкун': 'https://images.unsplash.com/photo-1552074284-5e88ef1aef18?w=800&q=85&auto=format&fit=crop',
            'кано': 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/10/Portrait_of_late_Mr._Kano.jpg/960px-Portrait_of_late_Mr._Kano.jpg',
            'каппадокия': 'https://images.unsplash.com/photo-1641128324972-af3212f0f6bd?w=800&q=85&auto=format&fit=crop',
            'карловы вары': 'https://upload.wikimedia.org/wikipedia/commons/d/d8/Karlovy_Vary_Czech.jpg',
            'картахена': 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Cartagena_palacio_consistorial5.jpg',
            'касабланка': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c0/Casablanca_-_P%C3%AAlem%C3%AAle_%2803%29.jpg/960px-Casablanca_-_P%C3%AAlem%C3%AAle_%2803%29.jpg',
            'касане': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7d/Kasane_aerial_view_%282019%29.jpg/3840px-Kasane_aerial_view_%282019%29.jpg',
            'квебек': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/01/%D0%93%D0%B8_%D0%91%D1%83%D1%88%D0%B5.jpg/960px-%D0%93%D0%B8_%D0%91%D1%83%D1%88%D0%B5.jpg',
            'кейп-кост': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/St_Francis_de_Sales_Cathedral_CapeCoast.jpg/960px-St_Francis_de_Sales_Cathedral_CapeCoast.jpg',
            'кейптаун': 'https://images.unsplash.com/photo-1580060839134-75a5edca2e99?w=800&q=85&auto=format&fit=crop',
            'кибуе': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/52/Exterior_of_Genocide_Memorial_Church_with_Never_Again_Display_in_Foreground_-_Karongi-Kibuye_-_Western_Rwanda.jpg/800px-Exterior_of_Genocide_Memorial_Church_with_Never_Again_Display_in_Foreground_-_Karongi-Kibuye_-_Western_Rwanda.jpg',
            'киев': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/%D0%91%D1%83%D0%B4%D0%B8%D0%BD%D0%BE%D0%BA_%D0%B7_%D1%85%D0%B8%D0%BC%D0%B5%D1%80%D0%B0%D0%BC%D0%B8%2C_%D1%81%D0%B5%D1%80%D0%BF%D0%B5%D0%BD%D1%8C_2019.jpg/960px-%D0%91%D1%83%D0%B4%D0%B8%D0%BD%D0%BE%D0%BA_%D0%B7_%D1%85%D0%B8%D0%BC%D0%B5%D1%80%D0%B0%D0%BC%D0%B8%2C_%D1%81%D0%B5%D1%80%D0%BF%D0%B5%D0%BD%D1%8C_2019.jpg',
            'килларни': 'https://upload.wikimedia.org/wikipedia/commons/5/5f/Killarney_-_Street_Scene_-_geograph.org.uk_-_661593.jpg',
            'кингстон': 'https://upload.wikimedia.org/wikipedia/commons/1/10/View_of_Kingston.jpg',
            'киото': 'https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=800&q=85&auto=format&fit=crop',
            'коимбра': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Coimbra_e_o_rio_Mondego_%286167200429%29_%28cropped%29.jpg/800px-Coimbra_e_o_rio_Mondego_%286167200429%29_%28cropped%29.jpg',
            'копенгаген': 'https://images.unsplash.com/photo-1513622470522-26c3c8a854bc?w=800&q=85&auto=format&fit=crop',
            'кордова': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/Montaje_CBA_9.jpg/960px-Montaje_CBA_9.jpg',
            'корк': 'https://upload.wikimedia.org/wikipedia/commons/1/15/Cork_City_Montage_Quick_Collage_of_CC_Commons_Cork_Images.jpg',
            'котор': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/%D0%9A%D0%BE%D1%82%D0%BE%D1%80-%D0%92%D0%B0%D1%80%D0%BE%D1%88_%28%D0%B3%D1%80%D0%B1%29.svg/800px-%D0%9A%D0%BE%D1%82%D0%BE%D1%80-%D0%92%D0%B0%D1%80%D0%BE%D1%88_%28%D0%B3%D1%80%D0%B1%29.svg.png',
            'крайстчерч': 'https://upload.wikimedia.org/wikipedia/commons/2/29/Christchurch_Montage_2011.jpg',
            'краков': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/89/Zamek_Kr%C3%B3lewski_na_Wawelu_%281%29.jpg/3840px-Zamek_Kr%C3%B3lewski_na_Wawelu_%281%29.jpg',
            'куала-лумпур': 'https://images.unsplash.com/photo-1596422846543-75c6fc197f07?w=800&q=85&auto=format&fit=crop',
            'куско': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/27/1-1Cusco.JPG/960px-1-1Cusco.JPG',
            'кёльн': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/Cologne_Montage_2016.png/800px-Cologne_Montage_2016.png',
            'ла-кондамин': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/Monaco-panorama.jpg/960px-Monaco-panorama.jpg',
            'ла-романа': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9f/Flag_of_the_Dominican_Republic.svg/960px-Flag_of_the_Dominican_Republic.svg.png',
            'ла-фортуна': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d6/TACA_airplanes_SJO_04_2005.jpg/960px-TACA_airplanes_SJO_04_2005.jpg',
            'лагос': 'https://upload.wikimedia.org/wikipedia/commons/f/f4/Tafa_Balewa_Square_%28Onikan%29_in_Lagos._Nigeria.jpg',
            'ларнака': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/87/Larnaca_01-2017_img14_Finikoudes.jpg/800px-Larnaca_01-2017_img14_Finikoudes.jpg',
            'лас-вегас': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e7/Las_Vegas_89.jpg/800px-Las_Vegas_89.jpg',
            'либерия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/94/Iglesia_Inmaculada_Concepcion_de_Maria%2C_Liberia%2C_Costa_Rica.JPG/960px-Iglesia_Inmaculada_Concepcion_de_Maria%2C_Liberia%2C_Costa_Rica.JPG',
            'ливерпуль': 'https://upload.wikimedia.org/wikipedia/commons/c/c1/Liverpool-Montage.jpg',
            'лиепая': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/53/LiepajaCollage.jpg/960px-LiepajaCollage.jpg',
            'лима': 'https://upload.wikimedia.org/wikipedia/commons/6/69/Bas%C3%ADlica_Catedral_Metropolitana_de_Lima_%28cropped%29.jpg',
            'лимасол': 'https://upload.wikimedia.org/wikipedia/commons/e/ed/Limassol_Montage_1.jpg',
            'лимерик': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Limerickcitycollage3.jpg/960px-Limerickcitycollage3.jpg',
            'линц': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f0/Linz_Blick_von_Freinbergstrasse_32-2_%28cropped%29.jpg/3840px-Linz_Blick_von_Freinbergstrasse_32-2_%28cropped%29.jpg',
            'лион': 'https://images.unsplash.com/photo-1632584063437-b83388122ed2?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlOUIlRDAlQjglRDAlQkUlRDAlQkQlMjAlRDAlQTQlRDElODAlRDAlQjAlRDAlQkQlRDElODYlRDAlQjglRDElOEYlMjB0cmF2ZWwlMjBsYW5kbWFyayUyMGRlc3RpbmF0aW9ufGVufDF8MHx8fDE3Nzg3NTA5Mjd8MA&ixlib=rb-4.1.0&q=80&w=400',
            'лиссабон': '/img/destinations/lisbon.jpg',
            'лозанна': 'https://images.unsplash.com/photo-1603989713458-b7ec73616c17?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlOUIlRDAlQkUlRDAlQjclRDAlQjAlRDAlQkQlRDAlQkQlRDAlQjAlMjAlRDAlQTglRDAlQjIlRDAlQjUlRDAlQjklRDElODYlRDAlQjAlRDElODAlRDAlQjglRDElOEYlMjB0cmF2ZWwlMjBsYW5kbWFyayUyMGRlc3RpbmF0aW9ufGVufDF8MHx8fDE3Nzg3NTA5NjZ8MA&ixlib=rb-4.1.0&q=80&w=400',
            'лондон': '/img/destinations/london.jpg',
            'лос-анджелес': 'https://images.unsplash.com/photo-1534190760961-74e8c1c5c3da?w=800&q=85&auto=format&fit=crop',
            'лунд': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f5/Stortorget_lund_080508.jpg/3840px-Stortorget_lund_080508.jpg',
            'льеж': 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/LuikVlag.svg/langru-960px-LuikVlag.svg.png',
            'любляна': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/72/Ljubljana_Montage.png/800px-Ljubljana_Montage.png',
            'люксембург': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/da/Flag_of_Luxembourg.svg/langru-960px-Flag_of_Luxembourg.svg.png',
            'люцерн': 'https://upload.wikimedia.org/wikipedia/commons/0/04/Lucerne_collage.png',
            'мадрид': 'https://images.unsplash.com/photo-1539037116277-4db20889f2d4?w=800&q=85&auto=format&fit=crop',
            'майами': 'https://images.unsplash.com/photo-1533106497176-45ae19e68ba2?w=800&q=85&auto=format&fit=crop',
            'малага': 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/31/Da_Gibralfaro.jpg/800px-Da_Gibralfaro.jpg',
            'мальдивы': 'https://images.unsplash.com/photo-1514282401047-d79a71a590e8?w=800&q=85&auto=format&fit=crop',
            'мальмё': 'https://upload.wikimedia.org/wikipedia/commons/2/24/Malm%C3%B6_collage.PNG',
            'манила': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f7/Cityscape_of_Manila%2C_2025_%2801%29.jpg/3840px-Cityscape_of_Manila%2C_2025_%2801%29.jpg',
            'манчестер': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Manchester_montage.jpg/800px-Manchester_montage.jpg',
            'марибор': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Maribor_cathedral_from_east.JPG/800px-Maribor_cathedral_from_east.JPG',
            'марина-бэй': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Marina_Bay_circuit_2023.svg/800px-Marina_Bay_circuit_2023.svg.png',
            'марракеш': 'https://images.unsplash.com/photo-1597212618440-806262de4f6b?w=800&q=85&auto=format&fit=crop',
            'марсель': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cc/OM_2026_logo.png/800px-OM_2026_logo.png',
            'маскат': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Mascate_collage.png/800px-Mascate_collage.png',
            'мдина': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d8/Mdina_montage.jpg/960px-Mdina_montage.jpg',
            'медельин': 'https://upload.wikimedia.org/wikipedia/commons/a/a5/Medellinpanoramicca.JPG',
            'мельбурн': 'https://images.unsplash.com/photo-1514395462725-fb4566210144?w=800&q=85&auto=format&fit=crop',
            'мендоса': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/53/Downtown_Mendoza.jpg/960px-Downtown_Mendoza.jpg',
            'мехико': 'https://images.unsplash.com/photo-1518659526054-190340b32735?w=800&q=85&auto=format&fit=crop',
            'милан': 'https://images.unsplash.com/photo-1520440229-6469a149ac59?w=800&q=85&auto=format&fit=crop',
            'минск': 'https://images.unsplash.com/photo-1591203601599-24b6e0d3f498?w=800&q=85&auto=format&fit=crop',
            'монреаль': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/dc/Flag_of_Montreal.svg/960px-Flag_of_Montreal.svg.png',
            'монтего-бей': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/Montego_bay-1001.jpg/960px-Montego_bay-1001.jpg',
            'монтеррей': 'https://upload.wikimedia.org/wikipedia/commons/0/03/MtyCollage3.jpg',
            'москва': '/img/destinations/moscow.jpg',
            'мумбаи': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/Marine_Lines_Mumbai_2021.jpg/3840px-Marine_Lines_Mumbai_2021.jpg',
            'мцхета': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e2/View_to_Mtskheta_from_Jvari.jpg/3840px-View_to_Mtskheta_from_Jvari.jpg',
            'мюнхен': 'https://images.unsplash.com/photo-1595867818082-083862f3d630?w=800&q=85&auto=format&fit=crop',
            'назарет': 'https://upload.wikimedia.org/wikipedia/commons/8/83/PikiWiki_Israel_17818_Cities_in_Israel.jpg',
            'найроби': 'https://upload.wikimedia.org/wikipedia/commons/6/66/Nairobi_Montage.jpg',
            'нара': 'https://images.unsplash.com/photo-1677409613125-5e0bc978947b?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlOUQlRDAlQjAlRDElODAlRDAlQjAlMjAlRDAlQUYlRDAlQkYlRDAlQkUlRDAlQkQlRDAlQjglRDElOEYlMjB0cmF2ZWwlMjBsYW5kbWFyayUyMGRlc3RpbmF0aW9ufGVufDF8MHx8fDE3Nzg3NTA5NDJ8MA&ixlib=rb-4.1.0&q=80&w=400',
            'нарва': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/60/Narva_asv2022-04_img09_Castle.jpg/800px-Narva_asv2022-04_img09_Castle.jpg',
            'неаполь': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/ca/Flag_of_Naples.svg/langru-960px-Flag_of_Naples.svg.png',
            'негрил': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0a/Flag_of_Jamaica.svg/960px-Flag_of_Jamaica.svg.png',
            'никосия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/City_walls_in_Nicosia.jpg/960px-City_walls_in_Nicosia.jpg',
            'ницца': 'https://images.unsplash.com/photo-1491166617655-0723a0999cfc?w=800&q=85&auto=format&fit=crop',
            'ниш': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c6/%D0%9D%D0%B8%D1%88_34.JPG/800px-%D0%9D%D0%B8%D1%88_34.JPG',
            'нови-сад': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/52/Novi_Sad_%28%C3%9Ajvid%C3%A9k%2C_Neusatz%2C_%D0%9D%D0%BE%D0%B2%D0%B8_%D0%A1%D0%B0%D0%B4%29_-_Bulevar_Mihajla_Pupina.JPG/800px-Novi_Sad_%28%C3%9Ajvid%C3%A9k%2C_Neusatz%2C_%D0%9D%D0%BE%D0%B2%D0%B8_%D0%A1%D0%B0%D0%B4%29_-_Bulevar_Mihajla_Pupina.JPG?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
            'нью-йорк': '/img/destinations/newyork.jpg',
            'оденсе': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Odense_r%C3%A5dhus.jpg/3840px-Odense_r%C3%A5dhus.jpg',
            'ольборг': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e7/Aalborg_NyTorv_2004_ubt.jpeg/960px-Aalborg_NyTorv_2004_ubt.jpeg',
            'ордино': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ae/HPIM0307.JPG/960px-HPIM0307.JPG',
            'орхус': 'https://upload.wikimedia.org/wikipedia/commons/8/8b/Montage_of_Aarhus_-_view_from_city_hall%2C_city_hall_by_night%2C_isbjerget%2C_park_alle.jpg',
            'орчард-роуд': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2d/New_Orchard_Road_Flower_Zone.jpg/800px-New_Orchard_Road_Flower_Zone.jpg',
            'осака': 'https://upload.wikimedia.org/wikipedia/commons/4/4b/Osaka_montage.jpg',
            'осло': 'https://images.unsplash.com/photo-1533929736458-ca588d08c8be?w=800&q=85&auto=format&fit=crop',
            'острава': 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Allostrava.jpeg',
            'оулу': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/59/Montage_Pokkinen_Oulu.jpg/3840px-Montage_Pokkinen_Oulu.jpg',
            'очо-риос': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Ochi.jpg/960px-Ochi.jpg',
            'палаван': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Palawan%2C_Tropical_rainforest_deep_in_Palawan_wilderness.jpg/3840px-Palawan%2C_Tropical_rainforest_deep_in_Palawan_wilderness.jpg',
            'париж': '/img/destinations/paris.jpg',
            'паттайя': 'https://upload.wikimedia.org/wikipedia/commons/0/04/Montage_Pattaya.jpg',
            'пекин': 'https://images.unsplash.com/photo-1508804185872-d7badad00f7d?w=800&q=85&auto=format&fit=crop',
            'пенанг': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fc/Skyline_of_George_Town%2C_Penang_at_night_November_2024_23-9.jpg/3840px-Skyline_of_George_Town%2C_Penang_at_night_November_2024_23-9.jpg',
            'петра': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/Al_Deir_Petra.JPG/3840px-Al_Deir_Petra.JPG',
            'печ': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fd/HUN_P%C3%A9cs_flag.svg/960px-HUN_P%C3%A9cs_flag.svg.png',
            'плайя-дель-кармен': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f3/Aerial_of_Playa_del_Carmen%2C_Mexico_%2828708057347%29.jpg/960px-Aerial_of_Playa_del_Carmen%2C_Mexico_%2828708057347%29.jpg',
            'подгорица': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/Titograd.jpg/800px-Titograd.jpg',
            'познань': 'https://upload.wikimedia.org/wikipedia/commons/5/53/Stary_Rynek_w_Poznaniu%2C_widok_z_drona.jpg',
            'порт-антонио': 'https://upload.wikimedia.org/wikipedia/commons/6/67/Il_bacio_%281974%29_-_Martine_Beswick_%28cropped%29.jpg',
            'порту': 'https://images.unsplash.com/photo-1555881400-74d7acaacd8b?w=800&q=85&auto=format&fit=crop',
            'прага': '/img/destinations/prague.jpg',
            'пукон': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/72/MunicipalidadPuc%C3%B3n.JPG/960px-MunicipalidadPuc%C3%B3n.JPG',
            'пула': 'https://upload.wikimedia.org/wikipedia/commons/b/bd/Pula_Aerial_View.jpg',
            'пунта-аренас': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fb/Fuerte_bulnes.JPG/960px-Fuerte_bulnes.JPG',
            'пунта-кана': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c8/Isla_Saona_-_panoramio.jpg/800px-Isla_Saona_-_panoramio.jpg',
            'пусан': 'https://upload.wikimedia.org/wikipedia/commons/0/08/Busan_montage.png',
            'пуэрто-вьехо': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f4/Andorra_la_Vieja_%281%29_06.jpg/960px-Andorra_la_Vieja_%281%29_06.jpg',
            'пуэрто-плата': 'https://upload.wikimedia.org/wikipedia/commons/6/6b/Ulises_Heureaux_cph.3a03374.jpg',
            'пхукет': 'https://images.unsplash.com/photo-1589394815804-964ed0be2eb5?w=800&q=85&auto=format&fit=crop',
            'пярну': 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/37/P%C3%A4rnu_kesklinn_-_Aerial_photo_of_P%C3%A4rnu_in_Estonia_%282%29.jpg/3840px-P%C3%A4rnu_kesklinn_-_Aerial_photo_of_P%C3%A4rnu_in_Estonia_%282%29.jpg',
            'рас-эль-хайма': 'https://images.unsplash.com/photo-1500153556700-4c8db53996c3?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlQTAlRDAlQjAlRDElODEtJUQxJThEJUQwJUJCJUQxJThDLSVEMCVBNSVEMCVCMCVEMCVCOSVEMCVCQyVEMCVCMCUyMCVEMCU5RSVEMCU5MCVEMCVBRCUyMHRyYXZlbCUyMGxhbmRtYXJrJTIwZGVzdGluYXRpb258ZW58MXwwfHx8MTc3ODc1MDkzOHww&ixlib=rb-4.1.0&q=80&w=400',
            'рейкьявик': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Reykjavik_Main_Image.jpg/960px-Reykjavik_Main_Image.jpg',
            'рига': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/84/Flag_of_Latvia.svg/960px-Flag_of_Latvia.svg.png',
            'рим': '/img/destinations/rome.jpg',
            'рио-де-жанейро': 'https://images.unsplash.com/photo-1483729558449-99ef09a8c325?w=800&q=85&auto=format&fit=crop',
            'рованиеми': 'https://upload.wikimedia.org/wikipedia/commons/4/44/Rovaniemi_-The_%E2%80%9DLumberjack%27s_Candle_Bridge.jpg',
            'родос': 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/30/Rhodes_NLT_Landsat7.png/800px-Rhodes_NLT_Landsat7.png',
            'роттердам': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f8/Erasmusbrug_seen_from_Euromast.jpg/800px-Erasmusbrug_seen_from_Euromast.jpg',
            'салала': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/08/Neuer_Tower.jpg/800px-Neuer_Tower.jpg',
            'салвадор': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bf/Salvador_BA.jpg/960px-Salvador_BA.jpg',
            'салоники': 'https://images.unsplash.com/photo-1603565816030-6b389eeb23cb?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlQTElRDAlQjAlRDAlQkIlRDAlQkUlRDAlQkQlRDAlQjglRDAlQkElRDAlQjglMjAlRDAlOTMlRDElODAlRDAlQjUlRDElODYlRDAlQjglRDElOEYlMjB0cmF2ZWwlMjBsYW5kbWFyayUyMGRlc3RpbmF0aW9ufGVufDF8MHx8fDE3Nzg3NTA5NTN8MA&ixlib=rb-4.1.0&q=80&w=400',
            'сальта': 'https://upload.wikimedia.org/wikipedia/commons/5/5e/Collage_Salta.PNG',
            'самана': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/54/Cabo_Cabr%C3%B3n%2C_%28Rinc%C3%B3n_Beach%29_Saman%C3%A1%2C_DR.JPG/800px-Cabo_Cabr%C3%B3n%2C_%28Rinc%C3%B3n_Beach%29_Saman%C3%A1%2C_DR.JPG',
            'самарканд': 'https://images.unsplash.com/photo-1596484552834-6a58f850e0a1?w=800&q=85&auto=format&fit=crop',
            'самуи': 'https://images.unsplash.com/photo-1755259042777-72e876a7d386?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlQTElRDAlQjAlRDAlQkMlRDElODMlRDAlQjglMjAlRDAlQTIlRDAlQjAlRDAlQjglRDAlQkIlRDAlQjAlRDAlQkQlRDAlQjQlMjB0cmF2ZWwlMjBsYW5kbWFyayUyMGRlc3RpbmF0aW9ufGVufDF8MHx8fDE3Nzg3NTA5NDF8MA&ixlib=rb-4.1.0&q=80&w=400',
            'сан-паулу': 'https://upload.wikimedia.org/wikipedia/commons/0/0a/Carlos_Prates_2026.jpg',
            'сан-франциско': 'https://images.unsplash.com/photo-1501594907352-04cda38ebc29?w=800&q=85&auto=format&fit=crop',
            'сан-хосе': 'https://upload.wikimedia.org/wikipedia/commons/f/f6/Ciudad_de_San_Jos%C3%A9.png',
            'санкт-петербург': '/img/destinations/spb.jpg',
            'санта-марта': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d9/Collage_Santa_Marta.jpg/960px-Collage_Santa_Marta.jpg',
            'санто-доминго': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9f/Flag_of_the_Dominican_Republic.svg/960px-Flag_of_the_Dominican_Republic.svg.png',
            'сантьяго': 'https://upload.wikimedia.org/wikipedia/commons/6/6a/Andes_y_Torre_Entel.jpg',
            'сантьяго-де-куба': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bc/2012-02-Sierra_Maestra_Turquino_Nationalpark_Kuba_01_anagoria.JPG/800px-2012-02-Sierra_Maestra_Turquino_Nationalpark_Kuba_01_anagoria.JPG',
            'сараево': 'https://upload.wikimedia.org/wikipedia/commons/9/9f/Distribution_of_Bulgarian_Speakers.png',
            'себу': 'https://upload.wikimedia.org/wikipedia/commons/4/45/Ph_locator_cebu_island.png',
            'севилья': 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Canal_de_Alfonso_XIII_Torre_del_Oro_Sevilla.jpg/800px-Canal_de_Alfonso_XIII_Torre_del_Oro_Sevilla.jpg',
            'сегед': 'https://upload.wikimedia.org/wikipedia/commons/a/ac/Szeged%2C_Tisza_river_bank%2C_with_Mora_Museum%2C_and_the_Theatre_building.jpg',
            'селфосс': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e6/SelfossViewFromNorthEast.jpg/960px-SelfossViewFromNorthEast.jpg',
            'сен-луи': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/25/St._Louis_Art_Museum.JPG/800px-St._Louis_Art_Museum.JPG',
            'серравалле': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bb/SerravalleRSMPanorama.JPG/800px-SerravalleRSMPanorama.JPG',
            'сеул': 'https://images.unsplash.com/photo-1534274988757-a28bf1a57c17?w=800&q=85&auto=format&fit=crop',
            'сиануквиль': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b5/Sihanoukville_airport_montage.jpg/800px-Sihanoukville_airport_montage.jpg',
            'сиань': 'https://upload.wikimedia.org/wikipedia/commons/e/ef/Xi%27an_montage.png',
            'сигулда': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bd/The_new_Sigulda_castle_%282%29.JPG/960px-The_new_Sigulda_castle_%282%29.JPG',
            'сидней': 'https://images.unsplash.com/photo-1506973035872-a4ec16b8e8d9?w=800&q=85&auto=format&fit=crop',
            'сиемреап': 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Front_porch_of_Wat_Damnak.jpg/3840px-Front_porch_of_Wat_Damnak.jpg',
            'сингапур': '/img/destinations/singapore.jpg',
            'скопье': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d5/Antigua_estaci%C3%B3n_de_ferrocarril%2C_Skopie%2C_Macedonia%2C_2014-04-17%2C_DD_15.JPG/800px-Antigua_estaci%C3%B3n_de_ferrocarril%2C_Skopie%2C_Macedonia%2C_2014-04-17%2C_DD_15.JPG',
            'софия': 'https://upload.wikimedia.org/wikipedia/commons/1/1d/Sofia_111.jpg',
            'сочи': '/img/destinations/sochi.jpg',
            'сплит': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Split_080620-133710-IMG_0968x.jpg/960px-Split_080620-133710-IMG_0968x.jpg',
            'ставангер': 'https://upload.wikimedia.org/wikipedia/commons/1/15/Vaagen-modf.jpg',
            'стамбул': '/img/destinations/istanbul.jpg',
            'стокгольм': 'https://images.unsplash.com/photo-1509356843151-3e7d96241e11?w=800&q=85&auto=format&fit=crop',
            'струга': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7c/Aerial_view_of_Struga%2C_Lake_Ohrid_%26_Black_Drin_%287%29.jpg/960px-Aerial_view_of_Struga%2C_Lake_Ohrid_%26_Black_Drin_%287%29.jpg',
            'суботица': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Subotica_Town_Hall_View_2.jpg/800px-Subotica_Town_Hall_View_2.jpg',
            'сурабая': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/09/Central_Surabaya_view_taken_from_JW_Marriott_Surabaya.jpg/3840px-Central_Surabaya_view_taken_from_JW_Marriott_Surabaya.jpg',
            'сьенфуэгос': 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/30/Camilo_Cienfuegos.jpg/800px-Camilo_Cienfuegos.jpg',
            'такоради': 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/19/Flag_of_Ghana.svg/960px-Flag_of_Ghana.svg.png',
            'таллин': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/Raekoja_plats_at_night.jpg/3840px-Raekoja_plats_at_night.jpg',
            'тамариндо': 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Tamarindo_aus_der_luft.jpg/960px-Tamarindo_aus_der_luft.jpg',
            'тампере': 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/Tampereen_tuomiokirkko_1.JPG/800px-Tampereen_tuomiokirkko_1.JPG',
            'тарту': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/Tartu_asv2022-04_img31_View_from_Emaj%C3%B5e_Tower.jpg/960px-Tartu_asv2022-04_img31_View_from_Emaj%C3%B5e_Tower.jpg',
            'ташкент': 'https://images.unsplash.com/photo-1624400890429-9bee103ff01b?w=800&q=85&auto=format&fit=crop',
            'тбилиси': 'https://images.unsplash.com/photo-1565008576549-57569a49371d?w=800&q=85&auto=format&fit=crop',
            'тель-авив': 'https://images.unsplash.com/photo-1544967082-d9d25d867d66?w=800&q=85&auto=format&fit=crop',
            'тетово': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e2/20090715_Tetovo_view_from_the_mountain.jpg/3840px-20090715_Tetovo_view_from_the_mountain.jpg',
            'тиват': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2b/Aerodrome_Tivat.jpg/800px-Aerodrome_Tivat.jpg',
            'тирана': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Skanderbeg_square_tirana_2016.jpg/800px-Skanderbeg_square_tirana_2016.jpg',
            'токио': '/img/destinations/tokyo.jpg',
            'торонто': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/CC_2022-06-18_193-Pano_%28cropped_lossless%29.jpg/960px-CC_2022-06-18_193-Pano_%28cropped_lossless%29.jpg',
            'требинье': 'https://upload.wikimedia.org/wikipedia/commons/5/56/Trebinje_Altstadt.jpg',
            'тринидад': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/55/Trinidad_%28Kuba%29_02.jpg/800px-Trinidad_%28Kuba%29_02.jpg',
            'тромсё': 'https://upload.wikimedia.org/wikipedia/commons/c/ce/Tromso_Troms%C3%B8_Norway_tunliweb_02.jpg',
            'тронхейм': 'https://upload.wikimedia.org/wikipedia/commons/e/e0/Overview_of_Trondheim_2008_03.jpg',
            'турку': 'https://upload.wikimedia.org/wikipedia/commons/2/2a/View_from_Turku_Cathedral_tower.jpg',
            'уппсала': 'https://upload.wikimedia.org/wikipedia/commons/6/6d/Uppsala.jpg',
            'утрехт': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Utrecht_Altstadt_07.jpg/800px-Utrecht_Altstadt_07.jpg',
            'фаро': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/Town_of_Faro.jpg/800px-Town_of_Faro.jpg',
            'фаэтано': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/FaetanoPanorama1.JPG/800px-FaetanoPanorama1.JPG',
            'фес': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/71/Medina_of_Fes%2C_Marocco.jpg/960px-Medina_of_Fes%2C_Marocco.jpg',
            'флоренция': 'https://images.unsplash.com/photo-1543429258-50f42a1d43be?w=800&q=85&auto=format&fit=crop',
            'флорианополис': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2a/Ponte_Herc%C3%ADlio_Luz_Florianopolis.jpg/960px-Ponte_Herc%C3%ADlio_Luz_Florianopolis.jpg',
            'франкфурт': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/Frankfurt_collage.jpg/800px-Frankfurt_collage.jpg',
            'хаапсалу': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cb/Auruvedur_Su_252-94_Haapsalus.jpg/960px-Auruvedur_Su_252-94_Haapsalus.jpg',
            'ханой': 'https://images.unsplash.com/photo-1583417319070-4a69db38a482?w=800&q=85&auto=format&fit=crop',
            'ханья': 'https://images.unsplash.com/photo-1655332285691-373850f637e5?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlQTUlRDAlQjAlRDAlQkQlRDElOEMlRDElOEYlMjAlRDAlOTMlRDElODAlRDAlQjUlRDElODYlRDAlQjglRDElOEYlMjB0cmF2ZWwlMjBsYW5kbWFyayUyMGRlc3RpbmF0aW9ufGVufDF8MHx8fDE3Nzg3NTA5NTN8MA&ixlib=rb-4.1.0&q=80&w=400',
            'харьков': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/92/%D0%92%D0%BE%D0%BA%D0%B7%D0%B0%D0%BB_%D0%BE%D1%81%D0%B5%D0%BD%D1%8C%D1%8E.jpeg/960px-%D0%92%D0%BE%D0%BA%D0%B7%D0%B0%D0%BB_%D0%BE%D1%81%D0%B5%D0%BD%D1%8C%D1%8E.jpeg',
            'хельсинки': 'https://images.unsplash.com/photo-1538332576228-eb5b4c4de6f5?w=800&q=85&auto=format&fit=crop',
            'хойан': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b1/H%E1%BB%99i_An%2C_Ancient_Town%2C_2020-01_CN-06.jpg/3840px-H%E1%BB%99i_An%2C_Ancient_Town%2C_2020-01_CN-06.jpg',
            'хошимин': 'https://images.unsplash.com/photo-1583417319070-4a69db38a482?w=800&q=85&auto=format&fit=crop',
            'хусавик': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f4/Harbor_of_Husavik.jpg/960px-Harbor_of_Husavik.jpg',
            'цюрих': 'https://images.unsplash.com/photo-1515488764276-beab7607c1e6?w=800&q=85&auto=format&fit=crop',
            'чанги': 'https://upload.wikimedia.org/wikipedia/commons/c/c9/Janggi_set.png',
            'черновцы': 'https://upload.wikimedia.org/wikipedia/commons/4/4e/%D0%9F%D0%BB.%D0%A6%D0%B5%D0%BD%D1%82%D1%80%D0%B0%D0%BB%D1%8C%D0%BD%D0%B0%2C_10_DSC_8826.jpg',
            'чески-крумлов': 'https://upload.wikimedia.org/wikipedia/commons/e/ed/Ceskykrumlov.JPG',
            'чиангмай': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Flag_of_Chiang_Mai_City_Municipality.svg/langru-330px-Flag_of_Chiang_Mai_City_Municipality.svg.png',
            'шанхай': 'https://images.unsplash.com/photo-1538428494232-9c0d8a3ab403?w=800&q=85&auto=format&fit=crop',
            'шарджа': 'https://images.unsplash.com/photo-1610991180393-15139efb078e?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w4Nzg1ODN8MHwxfHNlYXJjaHwxfHwlRDAlQTglRDAlQjAlRDElODAlRDAlQjQlRDAlQjYlRDAlQjAlMjAlRDAlOUUlRDAlOTAlRDAlQUQlMjB0cmF2ZWwlMjBsYW5kbWFyayUyMGRlc3RpbmF0aW9ufGVufDF8MHx8fDE3Nzg3NTA5MzB8MA&ixlib=rb-4.1.0&q=80&w=400',
            'шарм-эль-шейх': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/66/Sharm_El_Sheikh._Naama_Bay..jpg/960px-Sharm_El_Sheikh._Naama_Bay..jpg',
            'шкодер': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Skadarsko_jezero_2006.JPG/800px-Skadarsko_jezero_2006.JPG',
            'шри-ланка': 'https://images.unsplash.com/photo-1586523969944-8c04e8e24ba3?w=800&q=85&auto=format&fit=crop',
            'шымкент': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/66/Shymkent_logo.svg/langru-500px-Shymkent_logo.svg.png',
            'эгер': 'https://upload.wikimedia.org/wikipedia/commons/2/22/Eger_montage.JPG',
            'эдинбург': 'https://images.unsplash.com/photo-1506377585622-bedcbb027afc?w=800&q=85&auto=format&fit=crop',
            'эйндховен': 'https://upload.wikimedia.org/wikipedia/commons/7/75/Centrum_Eindhoven.jpg',
            'эш-сюр-альзет': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2a/Esch-sur-Alzette_-_Rue_de_l%27H%C3%B4pital_2016-08_--2.jpg/960px-Esch-sur-Alzette_-_Rue_de_l%27H%C3%B4pital_2016-08_--2.jpg'
        };
        const countryImageMap = {
            'Австралия': 'https://images.unsplash.com/photo-1506973035872-a4ec16b8e8d9?w=800&q=85&auto=format&fit=crop',
            'Австрия': 'https://upload.wikimedia.org/wikipedia/commons/f/f8/Gray558.png',
            'Азербайджан': 'https://images.unsplash.com/photo-1609177484694-d5530eeef150?w=800&q=85&auto=format&fit=crop',
            'Албания': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Skanderbeg_square_tirana_2016.jpg/960px-Skanderbeg_square_tirana_2016.jpg',
            'Алжир': 'https://images.unsplash.com/photo-1597212618440-806262de4f6b?w=800&q=85&auto=format&fit=crop',
            'Андорра': 'https://images.unsplash.com/photo-1543699539-33a389c5dcfe?w=800&q=85&auto=format&fit=crop',
            'Аргентина': 'https://upload.wikimedia.org/wikipedia/commons/4/4b/Montaje_de_la_Ciudad_de_Buenos_Aires.png',
            'Армения': 'https://images.unsplash.com/photo-1558015336-e3a15d558b05?w=800&q=85&auto=format&fit=crop',
            'Бахрейн': 'https://images.unsplash.com/photo-1572252009286-268acec5ca0a?w=800&q=85&auto=format&fit=crop',
            'Беларусь': 'https://images.unsplash.com/photo-1591203601599-24b6e0d3f498?w=800&q=85&auto=format&fit=crop',
            'Бельгия': 'https://upload.wikimedia.org/wikipedia/commons/c/c6/TE-Collage_Brussels.png',
            'Болгария': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c0/Map_of_the_Bulgarian_Diaspora_in_the_World.svg/960px-Map_of_the_Bulgarian_Diaspora_in_the_World.svg.png',
            'Боливия': 'https://images.unsplash.com/photo-1518659526054-190340b32735?w=800&q=85&auto=format&fit=crop',
            'Босния и Герцеговина': 'https://images.unsplash.com/photo-1555990538-1e2a6c6f7ec2?w=800&q=85&auto=format&fit=crop',
            'Ботсвана': 'https://images.unsplash.com/photo-1580060839134-75a5edca2e99?w=800&q=85&auto=format&fit=crop',
            'Бразилия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/94/Montagem_RJ.jpg/960px-Montagem_RJ.jpg',
            'Бутан': 'https://images.unsplash.com/photo-1545569310-12e1ed1de56e?w=800&q=85&auto=format&fit=crop',
            'Великобритания': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7d/London%2C_Elizabeth_Tower_--_2016_--_4807.jpg/960px-London%2C_Elizabeth_Tower_--_2016_--_4807.jpg',
            'Венгрия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/51/Map_of_the_Hungarian_Diaspora_in_the_World.svg/960px-Map_of_the_Hungarian_Diaspora_in_the_World.svg.png',
            'Венесуэла': 'https://images.unsplash.com/photo-1518659526054-190340b32735?w=800&q=85&auto=format&fit=crop',
            'Вьетнам': 'https://images.unsplash.com/photo-1583417319070-4a69db38a482?w=800&q=85&auto=format&fit=crop',
            'Гайана': 'https://images.unsplash.com/photo-1518659526054-190340b32735?w=800&q=85&auto=format&fit=crop',
            'Гана': 'https://images.unsplash.com/photo-1580060839134-75a5edca2e99?w=800&q=85&auto=format&fit=crop',
            'Германия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3b/Siegessaeule_Aussicht_10-13_img4_Tiergarten.jpg/960px-Siegessaeule_Aussicht_10-13_img4_Tiergarten.jpg',
            'Греция': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c6/Attica_06-13_Athens_50_View_from_Philopappos_-_Acropolis_Hill.jpg/960px-Attica_06-13_Athens_50_View_from_Philopappos_-_Acropolis_Hill.jpg',
            'Грузия': 'https://images.unsplash.com/photo-1565008576549-57569a49371d?w=800&q=85&auto=format&fit=crop',
            'Дания': 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3b/Christiansborg_fra_Nikolaj_Kirken.jpg/960px-Christiansborg_fra_Nikolaj_Kirken.jpg',
            'Доминикана': 'https://upload.wikimedia.org/wikipedia/commons/0/00/Stefano_Domenicali_2_%28cropped%29.jpg',
            'Египет': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/96/Pyramids_of_the_Giza_Necropolis.jpg/960px-Pyramids_of_the_Giza_Necropolis.jpg',
            'Израиль': 'https://images.unsplash.com/photo-1544967082-d9d25d867d66?w=800&q=85&auto=format&fit=crop',
            'Индия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1d/Taj_Mahal_%28Edited%29.jpeg/960px-Taj_Mahal_%28Edited%29.jpeg',
            'Индонезия': 'https://images.unsplash.com/photo-1537996194471-e657df975ab4?w=800&q=85&auto=format&fit=crop',
            'Иордания': 'https://images.unsplash.com/photo-1565008576549-57569a49371d?w=800&q=85&auto=format&fit=crop',
            'Ирландия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/42/Samuel_Beckett_Bridge_At_Sunset_Dublin_Ireland_%2897037639%29_%28cropped%29.jpeg/960px-Samuel_Beckett_Bridge_At_Sunset_Dublin_Ireland_%2897037639%29_%28cropped%29.jpeg',
            'Исландия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Iceland-txu-oclc-6654394-nq-27-28-4th-ed.jpg/960px-Iceland-txu-oclc-6654394-nq-27-28-4th-ed.jpg',
            'Испания': 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/Sagrada_Familia_%28July_2022%29_08.jpg/960px-Sagrada_Familia_%28July_2022%29_08.jpg',
            'Италия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Colosseo_2020.jpg/960px-Colosseo_2020.jpg',
            'Казахстан': 'https://images.unsplash.com/photo-1562008929-4dda1f5cb398?w=800&q=85&auto=format&fit=crop',
            'Камбоджа': 'https://images.unsplash.com/photo-1563492065-1a5b30bb1fcd?w=800&q=85&auto=format&fit=crop',
            'Канада': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/CC_2022-06-18_193-Pano_%28cropped_lossless%29.jpg/960px-CC_2022-06-18_193-Pano_%28cropped_lossless%29.jpg',
            'Катар': 'https://images.unsplash.com/photo-1559893088-c0787ebfc084?w=800&q=85&auto=format&fit=crop',
            'Кения': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/66/Nairobi_Montage.jpg/960px-Nairobi_Montage.jpg',
            'Кипр': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/81/Cyprus_lrg.jpg/960px-Cyprus_lrg.jpg',
            'Китай': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0e/Beijing_in_China_%28%2Ball_claims_hatched%29.svg/960px-Beijing_in_China_%28%2Ball_claims_hatched%29.svg.png',
            'Колумбия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/Washington_260424_US_Capitol_02.jpg/960px-Washington_260424_US_Capitol_02.jpg',
            'Коста-Рика': 'https://upload.wikimedia.org/wikipedia/commons/f/f6/Ciudad_de_San_Jos%C3%A9.png',
            'Куба': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/95/Habana_01_2014_7619.JPG/960px-Habana_01_2014_7619.JPG',
            'Кувейт': 'https://images.unsplash.com/photo-1572252009286-268acec5ca0a?w=800&q=85&auto=format&fit=crop',
            'Кыргызстан': 'https://images.unsplash.com/photo-1562008929-4dda1f5cb398?w=800&q=85&auto=format&fit=crop',
            'Лаос': 'https://images.unsplash.com/photo-1583417319070-4a69db38a482?w=800&q=85&auto=format&fit=crop',
            'Латвия': 'https://upload.wikimedia.org/wikipedia/commons/7/7d/Riga_montage.jpg',
            'Ливан': 'https://images.unsplash.com/photo-1582672060674-bc2bd808a8f5?w=800&q=85&auto=format&fit=crop',
            'Литва': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/63/Vilnius_Hbf_by_Augustas_Didzgalvis.jpg/960px-Vilnius_Hbf_by_Augustas_Didzgalvis.jpg',
            'Люксембург': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bd/Rosa_Luxemburg_%2827675721178%29.jpg/960px-Rosa_Luxemburg_%2827675721178%29.jpg',
            'Маврикий': 'https://upload.wikimedia.org/wikipedia/commons/6/66/Satellite_image_of_Mauritius_in_February_2003.jpg',
            'Малайзия': 'https://upload.wikimedia.org/wikipedia/commons/f/f5/East_Malaysia_Map_WorldFactBook.png',
            'Мальдивы': 'https://images.unsplash.com/photo-1514282401047-d79a71a590e8?w=800&q=85&auto=format&fit=crop',
            'Мальта': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b7/St_Sebastian_Curtain_%28cropped%29.jpg/960px-St_Sebastian_Curtain_%28cropped%29.jpg',
            'Марокко': 'https://upload.wikimedia.org/wikipedia/commons/f/f9/Marrakech_montage2.png',
            'Мексика': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/65/Montaje_de_CDMX.jpg/960px-Montaje_de_CDMX.jpg',
            'Молдова': 'https://images.unsplash.com/photo-1542813284-7f0b888a6062?w=800&q=85&auto=format&fit=crop',
            'Монако': 'https://upload.wikimedia.org/wikipedia/commons/3/37/Prince_Albert_II_of_Monaco_at_the_Enthronement_of_Naruhito_%281%29.jpg',
            'Монголия': 'https://images.unsplash.com/photo-1508804185872-d7badad00f7d?w=800&q=85&auto=format&fit=crop',
            'Мьянма': 'https://images.unsplash.com/photo-1582020437793-bb1c2cb2f6f4?w=800&q=85&auto=format&fit=crop',
            'Намибия': 'https://images.unsplash.com/photo-1580060839134-75a5edca2e99?w=800&q=85&auto=format&fit=crop',
            'Непал': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/ff/Kathmandu_montage.jpg/960px-Kathmandu_montage.jpg',
            'Нигерия': 'https://images.unsplash.com/photo-1580060839134-75a5edca2e99?w=800&q=85&auto=format&fit=crop',
            'Нидерланды': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/af/Museo_Nacional%2C_%C3%81msterdam%2C_Pa%C3%ADses_Bajos%2C_2016-05-30%2C_DD_16-18_HDR.jpg/960px-Museo_Nacional%2C_%C3%81msterdam%2C_Pa%C3%ADses_Bajos%2C_2016-05-30%2C_DD_16-18_HDR.jpg',
            'Новая Зеландия': 'https://images.unsplash.com/photo-1469521669194-babb45599def?w=800&q=85&auto=format&fit=crop',
            'Норвегия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/df/Oslojord_from_Ekeberg.jpg/960px-Oslojord_from_Ekeberg.jpg',
            'ОАЭ': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/86/DubaiCollage.jpg/960px-DubaiCollage.jpg',
            'Оман': 'https://images.unsplash.com/photo-1582672060674-bc2bd808a8f5?w=800&q=85&auto=format&fit=crop',
            'Парагвай': 'https://images.unsplash.com/photo-1589909202802-8f4aadce1849?w=800&q=85&auto=format&fit=crop',
            'Перу': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/62/80_-_Machu_Picchu_-_Juin_2009_-_edit.jpg/960px-80_-_Machu_Picchu_-_Juin_2009_-_edit.jpg',
            'Польша': 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Aleja_Niepdleglosci_Warsaw_2022_aerial_%28cropped%29.jpg/960px-Aleja_Niepdleglosci_Warsaw_2022_aerial_%28cropped%29.jpg',
            'Португалия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/21/Lisbon_Montage_2020.jpg/960px-Lisbon_Montage_2020.jpg',
            'Руанда': 'https://images.unsplash.com/photo-1580060839134-75a5edca2e99?w=800&q=85&auto=format&fit=crop',
            'Румыния': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/21/Map_of_the_Romanian_Diaspora_in_the_World.svg/960px-Map_of_the_Romanian_Diaspora_in_the_World.svg.png',
            'США': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/View_of_Empire_State_Building_from_Rockefeller_Center_New_York_City_dllu.jpg/960px-View_of_Empire_State_Building_from_Rockefeller_Center_New_York_City_dllu.jpg',
            'Сан-Марино': 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Collage_San_Marino.jpg/960px-Collage_San_Marino.jpg',
            'Саудовская Аравия': 'https://images.unsplash.com/photo-1586724237569-f3d0c1dee8c6?w=800&q=85&auto=format&fit=crop',
            'Северная Македония': 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/56/Vista_de_Skopie%2C_Macedonia%2C_2014-04-16%2C_DD_82.JPG/960px-Vista_de_Skopie%2C_Macedonia%2C_2014-04-16%2C_DD_82.JPG',
            'Сейшелы': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b1/Victoria_Clock_Tower_1.jpg/960px-Victoria_Clock_Tower_1.jpg',
            'Сенегал': 'https://images.unsplash.com/photo-1580060839134-75a5edca2e99?w=800&q=85&auto=format&fit=crop',
            'Сербия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/08/BelGrad_BM-21A.JPG/960px-BelGrad_BM-21A.JPG',
            'Сингапур': 'https://upload.wikimedia.org/wikipedia/commons/0/07/CIA_World_Factbook_map_of_Singapore_%28English%29.png',
            'Словакия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Hlavn%C3%A9_Namestie_%2835096533142%29.jpg/960px-Hlavn%C3%A9_Namestie_%2835096533142%29.jpg',
            'Словения': 'https://upload.wikimedia.org/wikipedia/commons/7/72/Ljubljana_Montage.png',
            'Таджикистан': 'https://images.unsplash.com/photo-1562008929-4dda1f5cb398?w=800&q=85&auto=format&fit=crop',
            'Таиланд': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a0/Bangkok_Montage.png/960px-Bangkok_Montage.png',
            'Танзания': 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/Mount_Kilimanjaro.jpg/960px-Mount_Kilimanjaro.jpg',
            'Тунис': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d6/Montage_ville_de_tunis.png/960px-Montage_ville_de_tunis.png',
            'Туркменистан': 'https://images.unsplash.com/photo-1542813284-7f0b888a6062?w=800&q=85&auto=format&fit=crop',
            'Турция': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Istanbul_University.png/960px-Istanbul_University.png',
            'Уганда': 'https://images.unsplash.com/photo-1580060839134-75a5edca2e99?w=800&q=85&auto=format&fit=crop',
            'Узбекистан': 'https://images.unsplash.com/photo-1624400890429-9bee103ff01b?w=800&q=85&auto=format&fit=crop',
            'Украина': 'https://images.unsplash.com/photo-1601887389937-0b62bbb6f8b1?w=800&q=85&auto=format&fit=crop',
            'Уругвай': 'https://images.unsplash.com/photo-1589909202802-8f4aadce1849?w=800&q=85&auto=format&fit=crop',
            'Филиппины': 'https://images.unsplash.com/photo-1518509562904-e7ef99cddc85?w=800&q=85&auto=format&fit=crop',
            'Финляндия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/HelsinkiMontage_NoEffects.jpg/960px-HelsinkiMontage_NoEffects.jpg',
            'Франция': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Tour_Eiffel_Wikimedia_Commons_%28cropped%29.jpg/960px-Tour_Eiffel_Wikimedia_Commons_%28cropped%29.jpg',
            'Хорватия': 'https://upload.wikimedia.org/wikipedia/commons/e/e9/Montage_of_major_Dubrovnik_landmarks.jpg',
            'Черногория': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c8/Montenegro%2C_Kotor_02.jpg/960px-Montenegro%2C_Kotor_02.jpg',
            'Чехия': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fb/Prague_Collage_2017.png/960px-Prague_Collage_2017.png',
            'Чили': 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/77/Shan_Hills%2C_Myanmar%2C_Red_chili_pepper_plant.jpg/960px-Shan_Hills%2C_Myanmar%2C_Red_chili_pepper_plant.jpg',
            'Швейцария': 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0f/Panoramablick_auf_die_Altstadt_von_Z%C3%BCrich_und_den_Z%C3%BCrichsee.jpg/960px-Panoramablick_auf_die_Altstadt_von_Z%C3%BCrich_und_den_Z%C3%BCrichsee.jpg',
            'Швеция': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Stockholm.jpg/960px-Stockholm.jpg',
            'Шри-Ланка': 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b6/Topography_Sri_Lanka.jpg/960px-Topography_Sri_Lanka.jpg',
            'Эквадор': 'https://images.unsplash.com/photo-1589909202802-8f4aadce1849?w=800&q=85&auto=format&fit=crop',
            'Эстония': 'https://upload.wikimedia.org/wikipedia/commons/4/42/Bronze_Soldier_12_May_2005.jpg',
            'Эфиопия': 'https://images.unsplash.com/photo-1580060839134-75a5edca2e99?w=800&q=85&auto=format&fit=crop',
            'ЮАР': 'https://upload.wikimedia.org/wikipedia/commons/1/11/Cape_Town_Montage.png',
            'Южная Корея': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/%EC%88%AD%EB%A1%80%EB%AC%B8_2_%28%ED%95%9C%EA%B5%AD%EA%B4%80%EA%B4%91%EA%B3%B5%EC%82%AC%29.jpg/960px-%EC%88%AD%EB%A1%80%EB%AC%B8_2_%28%ED%95%9C%EA%B5%AD%EA%B4%80%EA%B4%91%EA%B3%B5%EC%82%AC%29.jpg',
            'Ямайка': 'https://upload.wikimedia.org/wikipedia/commons/1/10/View_of_Kingston.jpg',
            'Япония': 'https://upload.wikimedia.org/wikipedia/commons/b/bf/Tokyo_Montage_2015.jpg',
            'Россия': 'https://images.unsplash.com/photo-1513326738677-b964603b136d?w=800&q=85&auto=format&fit=crop',
            'Панама': 'https://images.unsplash.com/photo-1518659526054-190340b32735?w=800&q=85&auto=format&fit=crop'
        };

        function tbHeartSvg() {
            return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';
        }
        function tbFavStore() {
            try {
                const raw = JSON.parse(localStorage.getItem('tbFavs') || '[]');
                if (Array.isArray(raw)) return raw;
                // Совместимость со старым форматом-объектом { "kind:key": {...} }
                if (raw && typeof raw === 'object') {
                    return Object.keys(raw).map((id) => {
                        const v = raw[id] || {};
                        const parts = id.split(':');
                        return { kind: v.kind || parts[0] || '', key: String(v.key || parts.slice(1).join(':') || '').toLowerCase(), title: v.title, payload: v.payload, at: v.at || 0 };
                    });
                }
                return [];
            } catch (e) { return []; }
        }
        function tbFavHas(kind, key) {
            const k = String(key || '').toLowerCase();
            return tbFavStore().some((x) => x.kind === kind && x.key === k) || Boolean(window.__tbFavSet && window.__tbFavSet.has(kind + ':' + k));
        }
        function tbFavRemember(kind, key, saved, title, payload) {
            const k = String(key || '').toLowerCase();
            let list = tbFavStore().filter((x) => !(x.kind === kind && x.key === k));
            if (saved) list.unshift({ kind, key: k, title, payload, at: Date.now() });
            try { localStorage.setItem('tbFavs', JSON.stringify(list.slice(0, 80))); } catch (e) {}
            if (!window.__tbFavSet) window.__tbFavSet = new Set();
            const id = kind + ':' + k;
            if (saved) window.__tbFavSet.add(id); else window.__tbFavSet.delete(id);
        }
        async function tbToggleFav(btn, kind, key, title, payload) {
            if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
            const on = !tbFavHas(kind, key);
            tbFavRemember(kind, key, on, title, payload);
            if (btn) btn.classList.toggle('is-on', on);
            try {
                const res = await fetch('/api/favorites/toggle', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ kind, key, title, payload }),
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok && typeof data.saved === 'boolean') {
                    tbFavRemember(kind, key, data.saved, title, payload);
                    if (btn) btn.classList.toggle('is-on', data.saved);
                }
            } catch (e) {}
        }
        function toggleResultFavorite() {
            const dest = tripData.destination || tripData.city || '';
            if (!dest) return;
            const btn = document.getElementById('rtbFavBtn');
            tbToggleFav(btn, 'trip', dest.toLowerCase(), dest, {
                city: tripData.city,
                country: tripData.country,
                days: tripData.daysCount,
            });
        }
        window.toggleResultFavorite = toggleResultFavorite;
        async function tbLoadFavs() {
            try {
                let token = '';
                try { token = sessionStorage.getItem('grok-auth.bearer-token') || ''; } catch (e) {}
                const tgInit = window.Telegram?.WebApp?.initData;
                if (!token && !tgInit) return;
                const res = await fetch('/api/me/favorites');
                if (!res.ok) return;
                const data = await res.json();
                if (!data.favorites) return;
                window.__tbFavSet = new Set(data.favorites.map((f) => f.kind + ':' + String(f.itemKey || '').toLowerCase()));
            } catch (e) {}
        }

        function destRating(city) {
            let h = 0;
            const s = String(city || '');
            for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * (i + 1)) % 40;
            return (4.5 + (h % 5) * 0.1).toFixed(1);
        }
        function destImage(dest) {
            let country = dest.country || '';
            if (!country && dest.city) {
                const found = cityToCountryMap[dest.city.toLowerCase()];
                if (found) country = found.name;
            }
            return dest.image
                || cityImageMap[dest.city.toLowerCase()]
                || (country && countryImageMap[country])
                || '/img/destinations/altai.jpg';
        }
        function renderFeatured(destinations) {
            const el = document.getElementById('s1Featured');
            if (!el) return;
            const list = (destinations || []).slice(0, 15);
            if (!list.length) { el.innerHTML = ''; return; }
            try { renderFeaturedUnsafe(el, list); } catch (e) {
                console.error('renderFeatured failed, fallback render:', e);
                try {
                    el.innerHTML = `<div class="s1-feat-scroll" id="s1FeatScroll">` + list.map((d, i) =>
                        `<div role="button" tabindex="0" class="s1-feat-card${i === 0 ? ' is-current' : ''}" data-i="${i}" data-city="${d.city}" data-country="${d.country || ''}" data-flag="${d.emoji || '🌍'}">`
                        + `<img src="${destImage(d)}" alt="${d.city}" loading="eager" decoding="async" onerror="this.onerror=null;this.src='/img/destinations/altai.jpg'" />`
                        + `<span class="s1-feat-name">${d.city}</span>`
                        + `<span class="s1-feat-country">${d.country || ''}</span>`
                        + `</div>`).join('') + `</div>`;
                    el.querySelectorAll('.s1-feat-card').forEach((card) => {
                        card.onclick = () => selectUnifiedDestination(card.dataset.city, card.dataset.country, card.dataset.flag);
                    });
                } catch (e2) { console.error('renderFeatured fallback failed:', e2); }
            }
        }
        function renderFeaturedUnsafe(el, list) {
            el.innerHTML = `<div class="s1-feat-scroll" id="s1FeatScroll">`
                + list.map((d, i) => {
                    const country = d.country || '';
                    const flag = d.emoji || '🌍';
                    const favKey = (d.city + ',' + country).toLowerCase();
                    return `<div role="button" tabindex="0" class="s1-feat-card${i === 0 ? ' is-current' : ''}" data-i="${i}" data-city="${d.city}" data-country="${country}" data-flag="${flag}">`
                        + `<img src="${destImage(d)}" alt="${d.city}" loading="eager" fetchpriority="high" decoding="async" onerror="this.onerror=null;this.src='/img/destinations/altai.jpg'" />`
                        + `<button type="button" class="s1-feat-heart tb-heart${tbFavHas('city', favKey) ? ' is-on' : ''}" data-fav-key="${favKey}" aria-label="В избранное">${tbHeartSvg()}</button>`
                        + `<span class="s1-feat-name">${d.city}</span>`
                        + `<span class="s1-feat-country">${country}</span>`
                        + `</div>`;
                }).join('')
                + `</div>`
                + `<div class="s1-feat-footer">`
                +   `<button type="button" class="s1-feat-cta" id="s1FeatCta">Выбрать</button>`
                +   `<div class="s1-feat-dots">${list.map((_, i) => `<span class="${i === 0 ? 'is-on' : ''}"></span>`).join('')}</div>`
                + `</div>`;
            const scrollEl = el.querySelector('#s1FeatScroll');
            const cards = Array.from(el.querySelectorAll('.s1-feat-card'));
            const dots = Array.from(el.querySelectorAll('.s1-feat-dots span'));
            const cta = el.querySelector('#s1FeatCta');
            let current = 0;
            const setCurrent = (i) => {
                current = i;
                cards.forEach((c, j) => c.classList.toggle('is-current', j === i));
                dots.forEach((dEl, j) => dEl.classList.toggle('is-on', j === i));
            };
            cards.forEach((card, i) => {
                card.onclick = () => selectUnifiedDestination(card.dataset.city, card.dataset.country, card.dataset.flag);
                const heart = card.querySelector('.s1-feat-heart');
                if (heart) {
                    heart.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        tbToggleFav(heart, 'city', heart.dataset.favKey, card.dataset.city, { city: card.dataset.city, country: card.dataset.country });
                    });
                }
            });
            if (cta) {
                cta.onclick = () => {
                    const d = list[current] || list[0];
                    if (d) selectUnifiedDestination(d.city, d.country || '', d.emoji || '🌍');
                };
            }
            if (scrollEl) {
                let raf = 0;
                scrollEl.addEventListener('scroll', () => {
                    if (raf) return;
                    raf = requestAnimationFrame(() => {
                        raf = 0;
                        const mid = scrollEl.scrollLeft + scrollEl.clientWidth / 2;
                        let best = 0, bestDist = Infinity;
                        cards.forEach((c, i) => {
                            const center = c.offsetLeft + c.offsetWidth / 2;
                            const dist = Math.abs(center - mid);
                            if (dist < bestDist) { bestDist = dist; best = i; }
                        });
                        if (best !== current) setCurrent(best);
                    });
                }, { passive: true });
            }
        }
        function renderRegionSections() {
            const worldWrap = document.getElementById('popularScroll');
            const russiaWrap = document.getElementById('popularScrollRussia');
            if (worldWrap) renderChipsInto(worldWrap, defaultPopularDestinations.slice(0, 15));
            if (russiaWrap) renderChipsInto(russiaWrap, russiaPopularDestinations.slice(0, 15));
            renderFeatured((travelRegion === 'russia' ? russiaPopularDestinations : defaultPopularDestinations).slice(0, 15));
        }
        function renderChipsInto(scroll, destinations) {
            scroll.innerHTML = '';
            destinations.forEach((dest, idx) => {
              try {
                let country = dest.country || '';
                if (!country && dest.city) {
                    const found = cityToCountryMap[dest.city.toLowerCase()];
                    if (found) country = found.name;
                }
                const image = destImage(dest);
                const flag = dest.emoji || '🌍';
                const rating = destRating(dest.city);
                const card = document.createElement('div');
                card.className = 's1-city-card';
                card.setAttribute('data-city', dest.city);
                card.setAttribute('data-country', country);
                card.setAttribute('data-flag', flag);
                const favKey = (dest.city + ',' + country).toLowerCase();
                card.innerHTML =
                    `<img src="${image}" alt="${dest.city}" loading="eager" decoding="async" onerror="this.onerror=null;this.src='/img/destinations/altai.jpg'"/>`
                    + `<div class="s1-city-overlay">`
                    +   `<span class="s1-city-name">${dest.city}</span>`
                    +   `<span class="s1-city-country">${country}</span>`
                    +   `<span class="s1-city-rating">★ ${rating}</span>`
                    + `</div>`
                    + `<span class="s1-city-flag">${flag}</span>`
                    + `<button type="button" class="s1-city-heart${tbFavHas('city', favKey) ? ' is-on' : ''}" data-fav-kind="city" data-fav-key="${favKey}" aria-label="В избранное">${tbHeartSvg()}</button>`
                    + `<div class="s1-check-badge"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>`;
                card.onclick = function(ev) {
                    if (ev.target.closest('.s1-city-heart')) return;
                    selectPopularDest(this);
                };
                card.querySelector('.s1-city-heart')?.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    tbToggleFav(ev.currentTarget, 'city', favKey, dest.city, { city: dest.city, country });
                });
                scroll.appendChild(card);
                const delay = idx * 50;
                setTimeout(() => {
                    card.style.animationDelay = delay + 'ms';
                    card.classList.add('s1-visible');
                }, 10);
              } catch (cardErr) {
                console.error('city card render failed:', dest && dest.city, cardErr);
              }
            });
        }
        function renderPopularChips(destinations) {
            // совместимость: старый вызов рендерит обе секции
            renderRegionSections();
        }

        // ── 3D tilt по движению мыши на карточках городов ──
        function initS1CardTilt() {
            const grid = document.getElementById('popularScroll');
            if (!grid) return;
            const MAX = 8;
            grid.addEventListener('pointermove', (e) => {
                const card = e.target.closest('.s1-city-card');
                if (!card) return;
                const r = card.getBoundingClientRect();
                const x = (e.clientX - r.left) / r.width  - 0.5;
                const y = (e.clientY - r.top)  / r.height - 0.5;
                card.style.transform =
                    `perspective(600px) rotateX(${(-y * MAX).toFixed(2)}deg) rotateY(${(x * MAX).toFixed(2)}deg) translateZ(0)` +
                    (card.classList.contains('s1-selected') ? ' scale(1.04)' : '');
            }, { passive: true });
            grid.addEventListener('pointerleave', () => {
                grid.querySelectorAll('.s1-city-card').forEach(c => { c.style.transform = ''; });
            }, { passive: true });
        }

        // ── Pulse-анимация CTA когда становится активным ──
        let _s1CtaWasDisabled = true;
        function s1MaybePulseCta() {
            const btn = document.getElementById('s1NextBtn');
            if (!btn) return;
            const isDisabled = btn.disabled;
            if (_s1CtaWasDisabled && !isDisabled) {
                btn.classList.remove('s1-cta-pulse');
                void btn.offsetWidth;
                btn.classList.add('s1-cta-pulse');
                setTimeout(() => btn.classList.remove('s1-cta-pulse'), 700);
            }
            _s1CtaWasDisabled = isDisabled;
        }
        // Stubs для backward compat
        function s1ResetCtaFixed() {}
        function initS1CtaAutoHide() {}

        /* ── UNIFIED SEARCH ── */
        let _unifiedDebounce = null;

        function onUnifiedSearchInput() {
            const input = document.getElementById('unifiedSearchInput');
            if (!input) return;
            const val = input.value;
            const wrap = input.closest('.s1-unified-wrap');
            if (wrap) wrap.classList.toggle('has-value', !!val);
            if (!val.trim()) clearSelectedDestination();
            clearTimeout(_unifiedDebounce);
            _unifiedDebounce = setTimeout(() => renderUnifiedSuggestions(val), 120);
        }
        function onUnifiedSearchFocus() {
            const input = document.getElementById('unifiedSearchInput');
            if (!input) return;
            renderUnifiedSuggestions(input.value);
        }
        function clearUnifiedSearch() {
            const input = document.getElementById('unifiedSearchInput');
            if (!input) return;
            input.value = '';
            const wrap = input.closest('.s1-unified-wrap');
            if (wrap) wrap.classList.remove('has-value');
            clearSelectedDestination();
            const box = document.getElementById('unifiedSuggestions');
            if (box) box.classList.add('hidden');
            input.focus();
        }
        function renderUnifiedSuggestions(query) {
            const box = document.getElementById('unifiedSuggestions');
            if (!box) return;
            const q = (query || '').trim().toLowerCase();
            let matches;
            if (!q) {
                matches = popularDestinations.slice(0, 8).map(d => {
                    const co = (typeof cityToCountryMap !== 'undefined' && cityToCountryMap[d.city.toLowerCase()]) || null;
                    return { city: d.city, country: co || { name: d.country || '', flag: d.emoji || '🌍' } };
                });
            } else {
                matches = allCities.filter(item => item.city.toLowerCase().startsWith(q)).slice(0, 8);
                if (matches.length < 6) {
                    const more = allCities.filter(item =>
                        !item.city.toLowerCase().startsWith(q) &&
                        item.city.toLowerCase().includes(q)
                    ).slice(0, 8 - matches.length);
                    matches = [...matches, ...more];
                }
            }
            if (travelRegion === 'russia') {
                matches = matches.filter((item) => (item.country && item.country.name) === 'Россия' || item.country?.flag === '🇷🇺');
            }
            box.innerHTML = '';
            if (q && matches.length === 0) {
                box.innerHTML = '<div class="suggestion-empty">Город не найден 🤷</div>';
                box.classList.remove('hidden');
                return;
            }
            matches.forEach(item => {
                const el = document.createElement('div');
                el.className = 'suggestion-item';
                el.innerHTML =
                    `<span class="si-flag">${item.country.flag || '🌍'}</span>` +
                    `<div class="si-texts">` +
                        `<span class="si-city">${item.city}</span>` +
                        `<span class="si-country">${item.country.name || ''}</span>` +
                    `</div>` +
                    `<svg class="si-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
                el.onpointerdown = (e) => {
                    e.preventDefault();
                    selectUnifiedDestination(item.city, item.country.name, item.country.flag || '🌍');
                };
                box.appendChild(el);
            });
            box.classList.remove('hidden');
        }
        function selectUnifiedDestination(city, country, flag) {
            const input = document.getElementById('unifiedSearchInput');
            if (input) {
                input.value = `${city}, ${country}`;
                const wrap = input.closest('.s1-unified-wrap');
                if (wrap) wrap.classList.add('has-value');
            }
            const co = document.getElementById('countryInput');
            const ci = document.getElementById('cityInput');
            if (co) co.value = country;
            if (ci) ci.value = city;
            clearInputError('countryInput');
            clearInputError('cityInput');
            const box = document.getElementById('unifiedSuggestions');
            if (box) box.classList.add('hidden');
            showSelectedChip(city, country, flag);
            updateMainButton();
            if (typeof tg !== 'undefined' && tg?.HapticFeedback) tg.HapticFeedback.selectionChanged();
            else if (navigator.vibrate) navigator.vibrate(8);
        }
        function clearSelectedDestination() {
            const co = document.getElementById('countryInput');
            const ci = document.getElementById('cityInput');
            if (co) co.value = '';
            if (ci) ci.value = '';
            const chip = document.getElementById('s1SelectedChip');
            if (chip) chip.classList.remove('is-visible');
            document.querySelectorAll('.s1-city-card.s1-selected').forEach(c => c.classList.remove('s1-selected'));
            updateMainButton();
        }
        function showSelectedChip(city, country, flag) {
            const chip = document.getElementById('s1SelectedChip');
            const cityEl = document.getElementById('s1ChipCity');
            const countryEl = document.getElementById('s1ChipCountry');
            const flagEl = document.getElementById('s1ChipFlag');
            if (!chip) return;
            if (cityEl) cityEl.textContent = city || '';
            if (countryEl) countryEl.textContent = country || '';
            if (flagEl) flagEl.textContent = flag || '🌍';
            updateBestTimeBadge(country);
            chip.classList.add('is-visible');
        }
        document.addEventListener('click', function(e) {
            if (!e.target.closest || !e.target.closest('.s1-unified-wrap')) {
                const box = document.getElementById('unifiedSuggestions');
                if (box) box.classList.add('hidden');
            }
        });

        /* ── BEST TIME TO VISIT ── */
        const CLIMATE_GROUPS = {
            mediterranean: ['Италия','Испания','Греция','Португалия','Хорватия','Кипр','Мальта','Черногория','Албания','Турция','Северная Македония','Босния и Герцеговина','Словения','Монако','Сан-Марино'],
            tropical: ['Индонезия','Таиланд','Тайланд','Вьетнам','Камбоджа','Лаос','Мьянма','Филиппины','Малайзия','Сингапур','Шри-Ланка','Мальдивы','Индия'],
            desert: ['ОАЭ','Катар','Бахрейн','Кувейт','Саудовская Аравия','Оман','Иран','Иордания','Израиль','Египет','Марокко','Тунис','Алжир','Ливан'],
            continental_eu: ['Франция','Германия','Великобритания','Бельгия','Нидерланды','Чехия','Австрия','Венгрия','Польша','Швейцария','Ирландия','Словакия','Литва','Латвия','Эстония','Люксембург','Лихтенштейн','Андорра','Украина','Беларусь','Молдова','Сербия','Румыния','Болгария'],
            nordic: ['Норвегия','Швеция','Финляндия','Дания','Исландия'],
            east_asia: ['Япония','Южная Корея','Китай','Тайвань','Гонконг','Монголия'],
            russia: ['Россия','Казахстан','Беларусь','Узбекистан','Кыргызстан','Таджикистан','Туркменистан','Грузия','Армения','Азербайджан'],
            north_america: ['США','Канада','Мексика','Куба','Доминикана','Ямайка','Гаити','Гватемала','Коста-Рика','Панама','Багамы'],
            south_america: ['Бразилия','Аргентина','Чили','Перу','Колумбия','Эквадор','Уругвай','Парагвай','Боливия','Венесуэла','Гайана'],
            oceania: ['Австралия','Новая Зеландия'],
            africa_other: ['ЮАР','Кения','Танзания','Эфиопия','Намибия','Ботсвана','Сенегал','Руанда','Уганда','Гана','Нигерия'],
        };
        const SEASONALITY = {
            mediterranean: [5, 5, 6, 8, 9, 10, 10, 10, 9, 8, 6, 5],
            tropical:      [10, 10, 9, 7, 5, 4, 4, 5, 5, 6, 8, 10],
            desert:        [9, 10, 10, 9, 6, 3, 2, 2, 4, 8, 9, 10],
            continental_eu: [4, 4, 6, 7, 9, 10, 10, 9, 8, 6, 4, 4],
            nordic:        [6, 6, 6, 6, 8, 10, 10, 9, 7, 6, 6, 7],
            east_asia:     [5, 5, 8, 10, 9, 7, 7, 7, 8, 10, 9, 6],
            russia:        [3, 3, 4, 6, 8, 9, 9, 9, 7, 5, 3, 3],
            north_america: [6, 6, 7, 8, 9, 9, 9, 9, 9, 8, 7, 6],
            south_america: [9, 9, 8, 7, 7, 7, 7, 8, 8, 8, 9, 9],
            oceania:       [10, 10, 9, 8, 6, 5, 5, 6, 7, 8, 9, 10],
            africa_other:  [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8],
        };
        const CITY_SEASON_OVERRIDES = {
            'бали':       [9, 9, 9, 9, 8, 8, 8, 9, 9, 9, 8, 8],
            'нью-йорк':   [3, 4, 6, 9, 10, 9, 8, 8, 9, 10, 7, 5],
            'москва':     [3, 3, 4, 6, 8, 10, 10, 9, 7, 5, 3, 3],
            'санкт-петербург': [3, 3, 4, 6, 8, 10, 10, 9, 7, 5, 3, 3],
            'дубай':      [10, 10, 10, 9, 5, 2, 1, 1, 3, 8, 9, 10],
            'токио':      [5, 5, 9, 10, 8, 6, 7, 7, 7, 10, 9, 7],
            'киото':      [5, 5, 9, 10, 8, 6, 7, 7, 7, 10, 9, 7],
            'рим':        [5, 5, 7, 9, 10, 9, 8, 8, 10, 9, 7, 5],
            'париж':      [4, 4, 6, 8, 10, 10, 9, 8, 9, 7, 5, 4],
        };
        function getCityClimateScore(cityName, countryName) {
            const month = new Date().getMonth();
            const cityKey = (cityName || '').toLowerCase();
            if (CITY_SEASON_OVERRIDES[cityKey]) return CITY_SEASON_OVERRIDES[cityKey][month];
            for (const [group, countries] of Object.entries(CLIMATE_GROUPS)) {
                if (countries.includes(countryName)) return SEASONALITY[group][month];
            }
            return 7;
        }
        function scoreToTier(score) {
            if (score >= 9) return { tier: 'ideal', label: 'Сейчас идеально' };
            if (score >= 7) return { tier: 'good',  label: 'Хорошее время' };
            if (score >= 5) return { tier: 'ok',    label: 'Средний сезон' };
            return            { tier: 'low',   label: 'Не лучший сезон' };
        }
        function updateBestTimeBadge(countryName) {
            const cityInput = document.getElementById('cityInput');
            const city = cityInput ? cityInput.value : '';
            const score = getCityClimateScore(city, countryName);
            const tier = scoreToTier(score);
            const wrap = document.getElementById('s1BestTime');
            const scoreEl = document.getElementById('s1BestTimeScore');
            const labelEl = document.getElementById('s1BestTimeLabel');
            if (!wrap) return;
            wrap.setAttribute('data-tier', tier.tier);
            if (scoreEl) scoreEl.textContent = `${score}/10`;
            if (labelEl) labelEl.textContent = tier.label;
        }

        /* ── ПОДБОР НАПРАВЛЕНИЯ ПО БАЗЕ ЗНАНИЙ ── */
        function toggleDreamPrompt() {
            const wrap = document.getElementById('s1Dream');
            if (!wrap) return;
            wrap.classList.toggle('is-open');
            if (wrap.classList.contains('is-open')) {
                setTimeout(() => {
                    const input = document.getElementById('s1DreamInput');
                    if (input) input.focus();
                }, 320);
            }
        }
        function useDreamExample(btn) {
            const input = document.getElementById('s1DreamInput');
            if (!input) return;
            input.value = btn.textContent.trim();
            input.focus();
        }
        async function submitDreamPrompt() {
            const input = document.getElementById('s1DreamInput');
            const btn = document.getElementById('s1DreamSubmit');
            const status = document.getElementById('s1DreamStatus');
            if (!input || !btn) return;
            const prompt = input.value.trim();
            if (!prompt) {
                if (status) {
                    status.textContent = 'Опишите чего хочется — хотя бы несколько слов';
                    status.className = 's1-dream-status is-error';
                }
                input.focus();
                return;
            }
            btn.classList.add('is-loading');
            btn.disabled = true;
            if (status) {
                status.innerHTML = 'Подбираем направление по отзывам путешественников...';
                status.className = 's1-dream-status';
            }
            try {
                const resp = await fetch('/api/knowledge-suggest', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ prompt, region: travelRegion })
                });
                const data = await resp.json();
                if (!resp.ok || !data.success) {
                    throw new Error(data.error || 'Не удалось подобрать направление. Опишите поездку иначе');
                }
                if (data.city && data.country) {
                    selectUnifiedDestination(data.city, data.country, data.flag || '🌍');
                    if (status) {
                        status.innerHTML = `✅ Подобрано: <b>${data.city}, ${data.country}</b>${data.reason ? ' — ' + data.reason : ''}`;
                        status.className = 's1-dream-status is-success';
                    }
                    if (Array.isArray(data.tripTypes) && data.tripTypes.length) window._kbSuggestedTypes = data.tripTypes;
                    if (data.wishes) window._kbSuggestedWishes = data.wishes;
                } else {
                    throw new Error('Неполный ответ по направлению');
                }
            } catch (e) {
                if (status) {
                    status.textContent = '❌ ' + e.message;
                    status.className = 's1-dream-status is-error';
                }
            } finally {
                btn.classList.remove('is-loading');
                btn.disabled = false;
            }
        }

        // ── Typewriter placeholder для unified search ──
        function initS1Typewriter() {
            const input = document.getElementById('unifiedSearchInput') || document.getElementById('cityInput');
            if (!input) return;
            const hints = ['Куда летим?', 'Токио', 'Барселона', 'Нью-Йорк', 'Бали', 'Рим', 'Париж', 'Дубай', 'Сингапур', 'Амстердам', 'Лиссабон'];
            let hi = 0, timerId = null, active = false;
            function stopTypewriter() {
                active = false;
                clearTimeout(timerId);
                input.placeholder = 'Город';
            }
            function runTypewriter() {
                if (document.activeElement === input || input.value) return;
                active = true;
                const word = hints[hi++ % hints.length];
                let i = 0;
                input.placeholder = '';
                function typeChar() {
                    if (!active || document.activeElement === input) return;
                    if (i < word.length) {
                        input.placeholder += word[i++];
                        timerId = setTimeout(typeChar, 90);
                    } else {
                        timerId = setTimeout(eraseChar, 1800);
                    }
                }
                function eraseChar() {
                    if (!active || document.activeElement === input) return;
                    if (input.placeholder.length > 0) {
                        input.placeholder = input.placeholder.slice(0, -1);
                        timerId = setTimeout(eraseChar, 45);
                    } else {
                        timerId = setTimeout(runTypewriter, 400);
                    }
                }
                typeChar();
            }
            input.addEventListener('focus', stopTypewriter);
            input.addEventListener('blur', () => {
                if (!input.value) { timerId = setTimeout(runTypewriter, 600); }
            });
            timerId = setTimeout(runTypewriter, 1200);
        }

        function setTravelRegion(region, opts) {
            travelRegion = region === 'russia' ? 'russia' : 'world';
            document.body.classList.toggle('region-russia', travelRegion === 'russia');
            document.getElementById('regionWorldBtn')?.classList.toggle('is-on', travelRegion === 'world');
            document.getElementById('regionRussiaBtn')?.classList.toggle('is-on', travelRegion === 'russia');
            document.getElementById('regionWorldBtn')?.setAttribute('aria-selected', travelRegion === 'world' ? 'true' : 'false');
            document.getElementById('regionRussiaBtn')?.setAttribute('aria-selected', travelRegion === 'russia' ? 'true' : 'false');
            const title = document.getElementById('s1Title');
            const sub = document.getElementById('s1Subtitle');
            const search = document.getElementById('unifiedSearchInput');
            const kicker = document.getElementById('regionKicker');
            const citiesLabel = document.getElementById('s1CitiesLabel');
            const examplesTitle = document.getElementById('exampleRoutesTitle');
            const loc = document.getElementById('s1LocLabel');
            if (loc) loc.textContent = travelRegion === 'russia' ? 'Россия' : 'Весь мир';
            if (kicker) kicker.textContent = travelRegion === 'russia' ? 'Путешествия по России' : 'Направления';
            if (title) title.textContent = travelRegion === 'russia' ? 'Куда едем в России?' : 'Куда отправимся?';
            if (sub) {
                sub.textContent = travelRegion === 'russia'
                    ? 'Подборки по России: Алтай, Камчатка, Дагестан, Золотое кольцо и другие направления по отзывам путешественников.'
                    : 'Система анализирует более 50 000 реальных отзывов и маршрутов опытных путешественников, чтобы составить ваш тур';
            }
            if (search) search.placeholder = travelRegion === 'russia' ? 'Город или регион России' : 'Куда хотите поехать?';
            if (citiesLabel) citiesLabel.textContent = travelRegion === 'russia' ? 'Направления по России' : 'Популярные';
            if (examplesTitle) examplesTitle.textContent = travelRegion === 'russia' ? 'Маршруты по России' : 'Готовые маршруты';
            const dreamExamples = document.querySelectorAll('.s1-dream-example');
            const suggestCopy = travelRegion === 'russia'
                ? ['Тихие горы Алтая без толп', 'Камчатка и вулканы в августе', 'Золотое кольцо, храмы и деревушки']
                : ['Спокойный отдых у моря в октябре', 'Романтический weekend в Европе', 'Гастрономия и вино, тёплая страна'];
            dreamExamples.forEach((el, i) => { if (suggestCopy[i]) el.textContent = suggestCopy[i]; });
            if (tg?.HapticFeedback) tg.HapticFeedback.selectionChanged();
            popularDestinations = travelRegion === 'russia' ? [...russiaPopularDestinations] : [...defaultPopularDestinations];
            renderFeatured(popularDestinations.slice(0, 15));
            // Без автоскролла: пользователь остаётся на месте при переключении региона
            fetch('/api/popular-destinations?region=' + travelRegion)
                .then((r) => r.json())
                .then((data) => {
                    if (data.destinations && data.destinations.length) {
                        popularDestinations = data.destinations;
                        renderFeatured(popularDestinations.slice(0, 15));
                    }
                })
                .catch(() => {});
            renderExampleRoutes();
            try { localStorage.setItem('tbRegion', travelRegion); } catch (e) {}
        }
        window.setTravelRegion = setTravelRegion;

        function setHomeTheme(btn, theme) {
            document.querySelectorAll('.s1-cat').forEach((b) => b.classList.remove('is-on'));
            if (btn) btn.classList.add('is-on');
            window.homeTheme = theme;
            if (tg?.HapticFeedback) tg.HapticFeedback.selectionChanged();
        }
        window.setHomeTheme = setHomeTheme;

        function initOnboard() {
            // Стартовый экран отключён: сразу показываем главную
            document.getElementById('tbOnboard')?.remove();
            document.body.classList.remove('onboarding');
        }

        function initPopularDestinations() {
            let saved = 'world';
            try { saved = localStorage.getItem('tbRegion') || 'world'; } catch (e) {}
            travelRegion = saved === 'russia' ? 'russia' : 'world';
            document.body.classList.toggle('region-russia', travelRegion === 'russia');
            document.getElementById('regionWorldBtn')?.classList.toggle('is-on', travelRegion === 'world');
            document.getElementById('regionRussiaBtn')?.classList.toggle('is-on', travelRegion === 'russia');
            renderRegionSections();
            renderExampleRoutes();
        }

        // ===== INLINE VALIDATION HELPERS =====
        function showInputError(inputId, message) {
            const input = document.getElementById(inputId);
            if (!input) return;
            input.classList.add('s1-input-error');
            // Remove old error message
            const oldErr = input.parentElement.querySelector('.s1-inline-error');
            if (oldErr) oldErr.remove();
            // Add new error
            const errEl = document.createElement('div');
            errEl.className = 's1-inline-error';
            errEl.textContent = message;
            input.parentElement.appendChild(errEl);
        }
        function clearInputError(inputId) {
            const input = document.getElementById(inputId);
            if (!input) return;
            input.classList.remove('s1-input-error');
            const errEl = input.parentElement.querySelector('.s1-inline-error');
            if (errEl) errEl.remove();
        }

        // ===== NEXT BUTTON STATE (works for both browser btn & Telegram MainButton) =====
        function updateNextButton() {
            const countryValue = document.getElementById('countryInput')?.value?.trim();
            const cityValue = document.getElementById('cityInput')?.value?.trim();
            const countryObj = getCountryByInput(countryValue || '');
            const isReady = !!(countryObj && cityValue);

            if (currentStep !== 1) return;

            // Browser custom button
            const btn = document.getElementById('s1NextBtn');
            if (btn) {
                btn.disabled = !isReady;
            }
            s1MaybePulseCta();

            // Telegram MainButton
            if (tg?.MainButton) {
                if (isReady) {
                    tg.MainButton.setParams({ text: 'ДАЛЕЕ →', is_active: true, is_visible: true, color: '#005F60' });
                } else {
                    tg.MainButton.setParams({ text: 'Выбери город', is_active: false, is_visible: true, color: '#8A8386' });
                }
            }
        }
        // Alias for backward compat
        const updateMainButton = updateNextButton;

        function initMainButton() {
            // Add .tma-mode to body if inside Telegram — hides custom button via CSS
            if (tg?.MainButton && tg.initData) {
                document.body.classList.add('tma-mode');
                tg.MainButton.setParams({ text: 'Выбери город', is_active: false, is_visible: true, color: '#8A8386' });
                tg.MainButton.onClick(() => {
                    if (currentStep === 1) nextStep(2);
                    else if (currentStep === 2) nextStep(3);
                });
            }
            // Track input changes to update both buttons
            const ci = document.getElementById('cityInput');
            const co = document.getElementById('countryInput');
            if (ci) ci.addEventListener('input', () => setTimeout(updateNextButton, 200));
            if (co) co.addEventListener('input', () => setTimeout(updateNextButton, 200));
        }
        
        function hideMainButton() {
            if (tg?.MainButton) tg.MainButton.hide();
        }

        // Update MainButton appearance based on current step
        function updateMainButtonForStep(step) {
            if (!tg?.MainButton) return;
            if (step === 1) {
                updateNextButton(); // existing step 1 logic
            } else if (step === 2) {
                tg.MainButton.setParams({ text: 'ДАЛЕЕ →', is_active: true, is_visible: true, color: '#005F60' });
                tg.MainButton.show();
            } else {
                tg.MainButton.hide();
            }
        }

        // ===== STEP 2 INLINE VALIDATION =====
        function s2ShowError(selector, message) {
            s2ClearAllErrors();
            const el = document.querySelector('#step2 ' + selector);
            if (!el) return;
            el.classList.add('s2-error');
            // Add error text below the element
            const errText = document.createElement('div');
            errText.className = 's2-error-text';
            errText.textContent = message;
            el.parentElement.insertBefore(errText, el.nextSibling);
            // Scroll to error
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Haptic
            if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('error');
            // Auto-clear on animation end
            el.addEventListener('animationend', () => {
                el.classList.remove('s2-error');
            }, { once: true });
        }

        function s2ClearAllErrors() {
            document.querySelectorAll('#step2 .s2-error').forEach(el => el.classList.remove('s2-error'));
            document.querySelectorAll('#step2 .s2-error-text').forEach(el => el.remove());
        }

        // ===== BOTTOM SHEET (Example Route Confirmation) =====
        let _pendingRouteId = null;

        function showRouteSheet(routeId) {
            const gold = (window.__tbGoldRoutes || []).map((r) => ({
                id: r.id,
                title: r.title,
                city: r.city,
                country: r.country,
                days: r.days,
                tags: r.tags || [],
                img: r.img,
                destination: `${r.city}, ${r.country}`,
                region: r.region,
            }));
            const route = exampleRoutes.find((r) => r.id === routeId) || gold.find((r) => r.id === routeId);
            if (!route) return;
            _pendingRouteId = routeId;
            const sheet = document.getElementById('routeBottomSheet');
            document.getElementById('bsRouteImg').src = route.img;
            document.getElementById('bsRouteTitle').textContent = route.title;
            document.getElementById('bsRouteMeta').textContent = `${route.days} дней · ${route.city}, ${route.country}`;
            document.getElementById('bsRouteTags').innerHTML = (route.tags || []).map((t) => `<span class="example-route-tag">${t}</span>`).join('');
            document.getElementById('bsRouteGo').onclick = () => {
                const id = _pendingRouteId;
                closeRouteSheet();
                if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
                loadExampleTrip(id);
            };
            sheet.classList.add('bs-visible');
            if (tg?.HapticFeedback) tg.HapticFeedback.selectionChanged();
        }

        function closeRouteSheet(e) {
            if (e && e.target !== e.currentTarget) return; // only close on overlay click
            const sheet = document.getElementById('routeBottomSheet');
            if (sheet) sheet.classList.remove('bs-visible');
            _pendingRouteId = null;
        }

        function nextStep(step) {
            try {
                if (step === 2) {
                    // Validate country + city with inline errors
                    const countryValue = document.getElementById('countryInput')?.value;
                    const cityValue = document.getElementById('cityInput')?.value?.trim();
                    const countryObj = getCountryByInput(countryValue || '');
                    let hasError = false;
                    
                    if (!countryObj) {
                        showInputError('countryInput', 'Выбери страну из списка');
                        hasError = true;
                    }
                    if (!cityValue) {
                        showInputError('cityInput', 'Введи или выбери город');
                        hasError = true;
                    }
                    if (hasError) {
                        if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('error');
                        return;
                    }
                    
                    tripData.country = countryObj.name;
                    tripData.city = cityValue;
                    tripData.destination = `${cityValue}, ${countryObj.name}`;
                    updateWizardRecap();
                    // Haptic on success
                    if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
                    // Show MainButton for step 2
                    updateMainButtonForStep(2);
                } else if (step === 3) {
                    // Clear previous errors
                    s2ClearAllErrors();

                    if (!tripData.tripType || selectedTripTypes.length === 0) {
                        if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('error');
                        s2ShowError('.triptype-grid', 'Выбери хотя бы один тип');
                        return;
                    }

                    if (tripMode === 'days') {
                        const daysCount = parseInt(document.getElementById('daysCountInput')?.value || '0', 10);
                        if (!daysCount || daysCount < 1) {
                            if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('error');
                            s2ShowError('.s2-dates-card', 'Укажи количество дней');
                            return;
                        }
                        tripData.daysCount = daysCount;
                        tripData.dateStart = '';
                        tripData.dateEnd = '';
                    } else {
                        tripData.dateStart = document.getElementById('dateStart').value;
                        tripData.dateEnd = document.getElementById('dateEnd').value;
                        if (!tripData.dateStart || !tripData.dateEnd) {
                            if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('error');
                            s2ShowError('.s2-dates-card', 'Укажи даты поездки');
                            return;
                        }
                        const start = new Date(tripData.dateStart);
                        const end = new Date(tripData.dateEnd);
                        if (end < start) {
                            if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('error');
                            s2ShowError('.s2-dates-card', 'Дата окончания не может быть раньше даты начала');
                            return;
                        }
                        tripData.daysCount = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
                    }
                    updateWizardRecap();
                    // Hide MainButton for step 3
                    hideMainButton();
                }

                animateStepTransition(currentStep, step, 'forward');
            } catch (e) {
                if (tg) { tg.showAlert('Ошибка: ' + e.message); } else { alert('Ошибка: ' + e.message); }
            }
        }

        let selectedCurrency = '$';
        let selectedCurrencyCode = 'USD';

        function onCurrencySelect() {
            const select = document.getElementById('currencySelect');
            const selectedOption = select.options[select.selectedIndex];
            selectedCurrency = selectedOption.getAttribute('data-symbol');
            selectedCurrencyCode = selectedOption.getAttribute('data-code') || 'USD';
            // Update currency sign in budget input
            const sign = document.getElementById('currencySign');
            if (sign) sign.textContent = selectedCurrency;
            readBudgetInputs();
        }


        function formatBudgetNum(n) {
            return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
        }

        function formatBudgetInput(el) {
            // Save cursor position
            const pos = el.selectionStart;
            const oldLen = el.value.length;
            // Strip non-digits
            let raw = el.value.replace(/[^\d]/g, '');
            // Format with spaces
            let formatted = raw.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
            el.value = formatted;
            // Restore cursor accounting for added/removed spaces
            const diff = formatted.length - oldLen;
            el.setSelectionRange(pos + diff, pos + diff);
        }

        function readBudgetInputs() {
            const rawPer = document.getElementById('budgetPerPerson')?.value?.replace(/\s/g, '').trim();
            const travelersCount = document.getElementById('travelersCount')?.value?.trim();

            const per = rawPer ? parseFloat(rawPer) : 0;
            const count = travelersCount ? parseInt(travelersCount, 10) : 0;

            if (per > 0 && count > 0) {
                tripData.budget = `≈ ${per} ${selectedCurrency} на человека (итого ≈ ${per * count} ${selectedCurrency})`;
                tripData.travelers = `${count}`;
                tripData.currency = selectedCurrency;
                tripData.currencyCode = selectedCurrencyCode;
                tripData.budgetPerPerson = per;
                tripData.budgetTotal = per * count;
            } else if (per > 0) {
                tripData.budget = `≈ ${per} ${selectedCurrency} на человека`;
                tripData.travelers = undefined;
                tripData.currency = selectedCurrency;
                tripData.currencyCode = selectedCurrencyCode;
                tripData.budgetPerPerson = per;
                tripData.budgetTotal = undefined;
            } else {
                tripData.budget = undefined;
                tripData.travelers = undefined;
                tripData.budgetPerPerson = undefined;
                tripData.budgetTotal = undefined;
            }
            updateBudgetHint(per, count);
        }

        function updateBudgetHint(per, count) {
            const valEl = document.getElementById('budgetTotalValue');
            const subEl = document.getElementById('budgetTotalSub');
            const hintEl = document.getElementById('budgetHint');
            if (!valEl || !subEl) return;
            if (per > 0 && count > 0) {
                const total = per * count;
                valEl.textContent = `${selectedCurrency}${formatBudgetNum(total)}`;
                if (hintEl) { hintEl.classList.remove('no-data'); }
                const plural = count === 1 ? 'человек' : count < 5 ? 'человека' : 'человек';
                subEl.textContent = `${selectedCurrency}${formatBudgetNum(per)} × ${count} ${plural}`;
            } else if (per > 0) {
                valEl.textContent = `${selectedCurrency}${formatBudgetNum(per)}`;
                if (hintEl) { hintEl.classList.add('no-data'); }
                subEl.textContent = 'Укажите количество людей';
            } else {
                valEl.textContent = '—';
                if (hintEl) { hintEl.classList.add('no-data'); }
                subEl.textContent = 'Укажите бюджет и кол-во людей';
            }
            updateGenerateBtn();
        }

        /* ===== NEW BUDGET UI FUNCTIONS ===== */
        function selectCurrencyBtn(btn) {
            // Visual: update grid buttons
            document.querySelectorAll('.currency-grid-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            // Sync hidden native select
            const code = btn.getAttribute('data-code');
            const symbol = btn.getAttribute('data-symbol');
            const select = document.getElementById('currencySelect');
            for (let i = 0; i < select.options.length; i++) {
                if (select.options[i].getAttribute('data-code') === code) {
                    select.selectedIndex = i;
                    break;
                }
            }
            onCurrencySelect();
        }

        function initCurrencyGrid() {
            const select = document.getElementById('currencySelect');
            const grid = document.getElementById('currencyGrid');
            if (!select || !grid) return;
            const PRIMARY = ['USD', 'EUR', 'RUB', 'KZT', 'GBP', 'TRY'];
            grid.innerHTML = '';
            for (const opt of select.options) {
                const code = opt.getAttribute('data-code');
                const symbol = opt.getAttribute('data-symbol');
                const text = opt.textContent.trim();
                const flag = text.split(' ')[0];
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'currency-grid-btn' + (PRIMARY.includes(code) ? '' : ' extra');
                if (code === 'USD') btn.classList.add('selected');
                btn.setAttribute('data-code', code);
                btn.setAttribute('data-symbol', symbol);
                btn.onclick = function() { selectCurrencyBtn(this); };
                btn.innerHTML = '<span class="cg-flag">' + flag + '</span><span class="cg-code">' + code + '</span>';
                grid.appendChild(btn);
            }
            const extraCount = select.options.length - PRIMARY.length;
            const moreBtn = document.getElementById('currencyMoreBtn');
            if (moreBtn) moreBtn.textContent = 'Ещё ' + extraCount + ' валют ▾';
        }

        function toggleMoreCurrencies() {
            const grid = document.getElementById('currencyGrid');
            const btn = document.getElementById('currencyMoreBtn');
            const searchWrap = document.getElementById('currencySearchWrap');
            const searchInput = document.getElementById('currencySearch');
            const isExpanding = !grid.classList.contains('expanded');
            grid.classList.toggle('expanded');
            if (isExpanding) {
                btn.textContent = 'Свернуть ▴';
                if (searchWrap) searchWrap.classList.add('visible');
            } else {
                const extraCount = document.querySelectorAll('.currency-grid-btn.extra').length;
                btn.textContent = 'Ещё ' + extraCount + ' валют ▾';
                if (searchWrap) searchWrap.classList.remove('visible');
                if (searchInput) { searchInput.value = ''; filterCurrencies(''); }
            }
        }

        function filterCurrencies(query) {
            const q = query.toLowerCase().trim();
            const btns = document.querySelectorAll('.currency-grid-btn');
            btns.forEach(btn => {
                if (!q) {
                    btn.classList.remove('currency-hidden');
                    return;
                }
                const code = (btn.getAttribute('data-code') || '').toLowerCase();
                const symbol = btn.getAttribute('data-symbol') || '';
                if (code.includes(q) || symbol.includes(q)) {
                    btn.classList.remove('currency-hidden');
                } else {
                    btn.classList.add('currency-hidden');
                }
            });
        }

        function changeTravelers(delta) {
            const input = document.getElementById('travelersCount');
            const display = document.getElementById('travelersDisplay');
            let val = parseInt(input.value || '2', 10) + delta;
            if (val < 1) val = 1;
            if (val > 20) val = 20;
            input.value = val;
            display.textContent = val;
            // Quick scale animation
            display.style.transform = 'scale(1.2)';
            setTimeout(() => { display.style.transform = 'scale(1)'; }, 150);
            readBudgetInputs();
        }

        function updateGenerateBtn() {
            const btn = document.getElementById('generateBtn');
            if (!btn) return;
            const rawPer = document.getElementById('budgetPerPerson')?.value?.replace(/\s/g, '').trim();
            const per = rawPer ? parseFloat(rawPer) : 0;
            const count = parseInt(document.getElementById('travelersCount')?.value || '0', 10);
            if (per > 0 && count > 0) {
                btn.classList.add('ready');
            } else {
                btn.classList.remove('ready');
            }
        }


        // ===== LOADING SCREEN — Streaming steps + Facts + Ken Burns photo =====
        const LS_STEPS_COUNT = 4;
        const LS_STEP_INITIAL_DUR = 4500;
        const LS_STEP_FAST_DUR = 600;
        const LS_FACT_INTERVAL = 4000;

        let lsCurrentStep = 0;
        let lsStepTimer = null;
        let lsFactTimer = null;
        let lsCompleteTimer = null;
        let lsApiDone = false;
        let lsApiResult = null;
        let lsAnimFinished = false;

        const LS_GENERIC_FACTS = [
            'Маршрут собирается по отзывам, дневникам и реальным точкам на карте',
            'Маршрут строится по районам — минимум пересечений и потерь времени',
            'Для каждого места подбирается реальное фото и описание',
            'Готовый план можно сохранить и поделиться с друзьями одной ссылкой',
            'Если выбраны даты — погода учитывается в маршруте',
        ];
        const LS_CITY_FACTS = {
            'париж':     ['В Париже более 130 музеев и 400 кинотеатров', 'Лувр — самый посещаемый музей мира (>9 млн в год)', 'Эйфелева башня изначально планировалась как временная на 20 лет'],
            'рим':       ['В Риме около 2000 фонтанов — больше чем в любом городе', 'Колизей мог вмещать до 80 000 зрителей', 'Из Рима можно попасть в Ватикан бесплатно — это отдельное государство'],
            'барселона': ['Саграда Фамилия строится с 1882 года и до сих пор не достроена', 'В Барселоне есть пляж прямо в городе — 4.5 км', 'La Boqueria — один из старейших рынков Европы (с 1217 года)'],
            'лондон':    ['В метро Лондона более 270 станций', 'Big Ben — это название колокола, а не башни', 'В Лондоне более 170 музеев, большинство — бесплатные'],
            'нью-йорк':  ['Центральный парк больше княжества Монако', 'Метро Нью-Йорка работает 24/7 — единственное в мире', 'Times Square переименован в честь газеты The New York Times'],
            'токио':     ['Токио — самая густонаселённая агломерация мира (37+ млн)', 'В метро Токио работают сотрудники-толкатели', 'Город ежегодно немного смещается из-за тектонических процессов'],
            'дубай':     ['Бурдж-Халифа имеет 163 этажа — самое высокое здание мира', 'В Дубае больше иностранцев чем местных (около 85%)', 'Полиция ездит на Lamborghini, Bugatti и Aston Martin'],
            'стамбул':   ['Стамбул — единственный город, расположенный на двух континентах', 'Голубая мечеть имеет 6 минаретов — единственная в Турции', 'Гранд-базар работает с 1461 года'],
            'амстердам': ['В Амстердаме около 1280 мостов — больше чем в Венеции', 'Велосипедов в городе больше чем жителей (~880 000)', 'Каналы внесены в список ЮНЕСКО'],
            'прага':     ['Карлов мост строился 45 лет, с 1357 до 1402', 'Пражские куранты работают с 1410 года', 'Прага — единственный город Европы, не пострадавший в WW2'],
            'бали':      ['На Бали более 20 000 храмов', 'У местных только 4 имени — Wayan, Made, Nyoman и Ketut', 'Каждые 210 дней проходит праздник Galungan'],
            'бангкок':   ['Полное имя Бангкока — самое длинное название города в мире', 'В городе более 400 буддийских храмов (wat)', 'Tuk-tuk изначально импортировали из Японии в 1934'],
        };

        let _lsCityFacts = [];
        let _lsFactIndex = 0;

        function buildFactsForCity(cityName) {
            const key = (cityName || '').toLowerCase().trim();
            const cityFacts = LS_CITY_FACTS[key] || [];
            const generic = [...LS_GENERIC_FACTS].sort(() => Math.random() - 0.5);
            return [...cityFacts, ...generic];
        }

        function rotateFact() {
            const el = document.getElementById('lsFactText');
            if (!el || !_lsCityFacts.length) return;
            el.classList.add('is-changing');
            setTimeout(() => {
                _lsFactIndex = (_lsFactIndex + 1) % _lsCityFacts.length;
                el.textContent = _lsCityFacts[_lsFactIndex];
                el.classList.remove('is-changing');
            }, 400);
        }

        function setupLoadingHeader(cityName, countryName) {
            const nameEl = document.getElementById('lsCityName');
            const flagEl = document.getElementById('lsCityFlag');
            if (nameEl) nameEl.textContent = cityName || 'Маршрут';

            let flag = '🌍';
            if (countryName && typeof countriesData !== 'undefined') {
                const co = countriesData.find(c => c.name === countryName);
                if (co) flag = co.flag;
            }
            if (flagEl) flagEl.textContent = flag;

            const step0Sub = document.getElementById('lsStep0Sub');
            if (step0Sub && cityName) step0Sub.textContent = `Изучаю особенности города ${cityName}`;

            const bg = document.getElementById('lsBgPhoto');
            if (bg) {
                const cityKey = (cityName || '').toLowerCase();
                let imgUrl =
                    (typeof cityImageMap !== 'undefined' && cityImageMap[cityKey]) ||
                    (typeof countryImageMap !== 'undefined' && countryName && countryImageMap[countryName]) ||
                    'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=1200&q=85&auto=format&fit=crop';
                const tmp = new Image();
                tmp.onload = () => {
                    bg.style.backgroundImage = `url('${imgUrl}')`;
                    bg.classList.add('loaded');
                };
                tmp.onerror = () => { bg.classList.add('loaded'); };
                tmp.src = imgUrl;
            }

            _lsCityFacts = buildFactsForCity(cityName);
            _lsFactIndex = 0;
            const factEl = document.getElementById('lsFactText');
            if (factEl && _lsCityFacts.length) {
                factEl.textContent = _lsCityFacts[0];
            }
            clearInterval(lsFactTimer);
            lsFactTimer = setInterval(rotateFact, LS_FACT_INTERVAL);
        }

        function startLoadingAnimation() {
            lsCurrentStep = 0;
            lsApiDone = false;
            lsApiResult = null;
            lsAnimFinished = false;

            document.querySelectorAll('#lsSteps .ls-step').forEach(el => {
                el.classList.remove('is-active', 'is-done');
            });

            const city = (tripData && tripData.city) || '';
            const country = (tripData && tripData.country) || '';
            setupLoadingHeader(city, country);

            advanceToStep(0);
        }

        function advanceToStep(stepIdx) {
            lsCurrentStep = stepIdx;
            const steps = document.querySelectorAll('#lsSteps .ls-step');
            steps.forEach((el, i) => {
                if (i < stepIdx) {
                    el.classList.add('is-done');
                    el.classList.remove('is-active');
                } else if (i === stepIdx) {
                    el.classList.add('is-active');
                    el.classList.remove('is-done');
                } else {
                    el.classList.remove('is-active', 'is-done');
                }
            });

            clearTimeout(lsStepTimer);
            if (stepIdx >= LS_STEPS_COUNT - 1) {
                if (lsApiDone) {
                    lsStepTimer = setTimeout(finalizeLoading, 800);
                }
            } else {
                const dur = lsApiDone ? LS_STEP_FAST_DUR : LS_STEP_INITIAL_DUR;
                lsStepTimer = setTimeout(() => advanceToStep(stepIdx + 1), dur);
            }
        }

        function finalizeLoading() {
            if (lsAnimFinished) return;
            lsAnimFinished = true;
            clearTimeout(lsStepTimer);
            clearInterval(lsFactTimer);
            document.querySelectorAll('#lsSteps .ls-step').forEach(el => {
                el.classList.add('is-done');
                el.classList.remove('is-active');
            });
            if (typeof tg !== 'undefined' && tg?.HapticFeedback) {
                tg.HapticFeedback.notificationOccurred('success');
            }
            clearTimeout(lsCompleteTimer);
            lsCompleteTimer = setTimeout(() => onLoadingComplete(), 500);
        }

        function onApiComplete(result) {
            lsApiDone = true;
            lsApiResult = result;
            if (lsAnimFinished) {
                clearTimeout(lsCompleteTimer);
                lsCompleteTimer = setTimeout(() => onLoadingComplete(), 200);
                return;
            }
            if (lsCurrentStep >= LS_STEPS_COUNT - 1) {
                clearTimeout(lsStepTimer);
                lsStepTimer = setTimeout(finalizeLoading, 600);
                return;
            }
            clearTimeout(lsStepTimer);
            lsStepTimer = setTimeout(() => advanceToStep(lsCurrentStep + 1), LS_STEP_FAST_DUR);
        }

        function onLoadingComplete() {
            clearTimeout(lsStepTimer);
            clearTimeout(lsCompleteTimer);
            clearInterval(lsFactTimer);
            try {
                if (lsApiResult && lsApiResult.success && (lsApiResult.plan || lsApiResult.planJson)) {
                    processApiResult(lsApiResult);
                } else {
                    console.warn('onLoadingComplete: no successful result, using local fallback', lsApiResult);
                    processApiResult(buildClientFallback(lsApiResult && lsApiResult.error));
                }
            } catch (e) {
                console.error('processApiResult failed:', e);
                try {
                    processApiResult(buildClientFallback(e.message || e));
                } catch (e2) {
                    console.error('fallback render failed:', e2);
                    // Последний рубеж: показать сырой текст плана без карты и интерактива
                    try {
                        showResultView();
                        const mapSection = document.getElementById('mapSection');
                        if (mapSection) mapSection.classList.add('hidden');
                        const dtEl = document.getElementById('dayText');
                        if (dtEl && typeof formatDayContent === 'function') {
                            dtEl.style.display = 'block';
                            const rawPlan = (lsApiResult && lsApiResult.plan) || 'Маршрут готов. Попробуйте обновить страницу для интерактивного режима.';
                            dtEl.innerHTML = formatDayContent(rawPlan);
                        }
                    } catch (e3) {
                        document.getElementById('loading')?.classList.add('hidden');
                        if (typeof showGenError === 'function') {
                            showGenError({
                                icon: '⚠️',
                                title: 'Ошибка обработки',
                                text: 'План получен, но не удалось отрисовать: ' + (e.message || e)
                            });
                        }
                    }
                }
            }
        }

        function hideWizardSteps() {
            ['step1', 'step2', 'step3', 'screenTrips', 'screenPricing', 'screenCabinet'].forEach((id) => {
                document.getElementById(id)?.classList.add('hidden');
            });
            document.getElementById('stepIndicator')?.classList.add('hidden');
            const progressFill = document.getElementById('stepProgressFill');
            if (progressFill && progressFill.parentElement) {
                progressFill.parentElement.style.display = 'none';
            }
            window.scrollTo({ top: 0, behavior: 'auto' });
        }

        function showLoadingView() {
            hideWizardSteps();
            document.body.classList.remove('result-mode');
            document.body.classList.add('loading-mode');
            const result = document.getElementById('result');
            if (result) result.classList.add('hidden');
            const loading = document.getElementById('loading');
            if (loading) loading.classList.remove('hidden');
            const sub = document.querySelector('#loading .ls-subtitle-new');
            if (sub) {
                sub.textContent = 'Собираем маршрут по картам и гидам...';
                // Честный счётчик: сколько документов реально лежит в базе знаний.
                fetch('/api/kb-stats')
                    .then((r) => r.json())
                    .then((s) => {
                        const n = Number(s && s.rawDocuments) || 0;
                        if (n > 0) {
                            sub.textContent = `Анализируем ${n} маршрутов и отзывов путешественников...`;
                        }
                    })
                    .catch(() => {});
            }
            startLoadingAnimation();
            window.scrollTo({ top: 0, behavior: 'auto' });
        }

        function showResultView() {
            hideWizardSteps();
            document.body.classList.remove('loading-mode');
            const loading = document.getElementById('loading');
            if (loading) loading.classList.add('hidden');
            const result = document.getElementById('result');
            if (result) result.classList.remove('hidden');
            document.body.classList.add('result-mode');
            const bottomTabs = document.getElementById('bottomTabs');
            if (bottomTabs) bottomTabs.style.display = 'block';
            const mapSection = document.getElementById('mapSection');
            if (mapSection) mapSection.classList.remove('hidden');
            window.scrollTo({ top: 0, behavior: 'auto' });
        }

        function persistActiveTrip(payload) {
            try {
                sessionStorage.setItem(TB_ACTIVE_KEY, JSON.stringify({
                    tripData,
                    plan: payload.plan || currentPlanText || '',
                    planJson: payload.planJson || currentPlanJson,
                    coords: payload.coords || destCoords,
                    access: payload.access || window.__tbAccess || null,
                    tripId: payload.tripId || currentTripId || window.__tbTripId || null,
                    pages: payload.pages || window.__tbPages || null,
                    source: payload.source || window.__tbSource || null,
                    savedAt: Date.now(),
                }));
            } catch (e) { /* ignore quota */ }
        }

        let persistTimer = null;
        window._tbMarkers = window._tbMarkers || {};

        function showSaveToast(msg) {
            const el = document.getElementById('saveToast');
            if (!el) return;
            el.textContent = msg || 'Страница сохранена';
            el.classList.add('show');
            setTimeout(() => el.classList.remove('show'), 1600);
        }

        function rebuildPlanJsonFromDays() {
            if (!currentPlanJson) {
                currentPlanJson = {
                    destination: tripData.destination || tripData.city || '',
                    country: tripData.country || '',
                    theme: tripData.tripType || '',
                    days: [],
                    hotels: [],
                    dailyBudget: {},
                    tips: [],
                };
            }
            currentPlanJson.days = planDays.filter((d) => !d.locked).map((d, i) => ({
                day: i + 1,
                district: (currentPlanJson.days && currentPlanJson.days[i] && currentPlanJson.days[i].district) || d.district || '',
                places: Array.isArray(d.jsonPlaces) ? d.jsonPlaces : [],
            }));
            currentPlanText = planDays.filter((d) => !d.locked).map((d) => d.content).join('\n\n');
        }

        function persistPlanDebounced() {
            rebuildPlanJsonFromDays();
            persistActiveTrip({
                plan: currentPlanText,
                planJson: currentPlanJson,
                coords: destCoords,
                access: window.__tbAccess,
                tripId: currentTripId,
                pages: window.__tbPages,
                source: window.__tbSource,
            });
            clearTimeout(persistTimer);
            persistTimer = setTimeout(pushPlanToServer, 700);
        }

        async function pushPlanToServer() {
            if (!currentTripId || !currentPlanJson) return;
            try {
                await fetch('/api/trips/replace-plan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        tripId: currentTripId,
                        planJson: currentPlanJson,
                        planText: currentPlanText || '',
                    }),
                });
            } catch (e) { /* offline ok */ }
        }

        function writePlacesBack(dayIndex, places) {
            const day = planDays[dayIndex];
            if (!day) return;
            const prev = Array.isArray(day.jsonPlaces) ? day.jsonPlaces : [];
            day.jsonPlaces = (places || []).map((p, i) => {
                const hit = prev.find((x) => String(x.name).toLowerCase() === String(p.name || '').toLowerCase()) || prev[i] || {};
                return {
                    name: p.name,
                    address: p.address || hit.address || '',
                    timeStart: p.timeStart || hit.timeStart || '',
                    timeEnd: p.timeEnd || hit.timeEnd || '',
                    durationMin: p.durationMin || hit.durationMin || 80,
                    walkMinFromPrev: p.walkMinFromPrev || hit.walkMinFromPrev || 0,
                    description: p.description || hit.description || '',
                    price: p.price || hit.price || '',
                    lat: p.lat,
                    lon: p.lon,
                    kind: p.kind || hit.kind || '',
                };
            });
            day.content = dayContentFromPlaces(day.jsonPlaces);
            allDaysPlaceInfo[dayIndex] = places;
            persistPlanDebounced();
        }

        function focusPlaceOnMap(dayIndex, placeIdx) {
            document.querySelectorAll('.place-card').forEach((c, i) => c.classList.toggle('selected', i === placeIdx));
            const marker = window._tbMarkers[dayIndex + '-' + placeIdx];
            if (marker && leafletMap) {
                try {
                    leafletMap.flyTo(marker.getLatLng(), Math.max(leafletMap.getZoom(), 16), { duration: 0.4 });
                    marker.openPopup();
                } catch (e) {}
            }
        }
        window.focusPlaceOnMap = focusPlaceOnMap;

        function updateWizardRecap() {
            const s2 = document.getElementById('s2Recap');
            const s3 = document.getElementById('s3Recap');
            const city = tripData.destination || [tripData.city, tripData.country].filter(Boolean).join(', ');
            if (s2) s2.textContent = city ? ('Направление: ' + city) : '';
            if (s3) {
                const bits = [];
                if (city) bits.push(city);
                if (tripData.daysCount) bits.push(tripData.daysCount + ' дн.');
                if (tripData.tripType) bits.push(tripData.tripType);
                s3.textContent = bits.join(' · ');
            }
        }

        function renderStructuredPages() {
            renderHotelsPage();
            renderTipsPage();
        }

        function renderHotelsPage() {
            const root = document.getElementById('hotelsPage');
            if (!root) return;
            const hotels = (currentPlanJson && currentPlanJson.hotels) || [];
            if (!hotels.length) {
                root.innerHTML = '<div class="page-editor"><h3>Отели</h3><p class="page-editor-sub">Отдельная страница. После генерации здесь появятся варианты рядом с первым днём.</p></div>';
                return;
            }
            root.innerHTML = '<div class="page-editor"><h3>Отели</h3><p class="page-editor-sub">Страница жилья — правки сохраняются в кабинете.</p>' +
                hotels.map((h, i) => `<div class="hotel-card-edit">
                    <strong>${esc(h.name || '')}</strong>
                    <div class="muted">${esc(h.area || '')} ${esc(h.pricePerNight || '')}</div>
                    <label class="page-field"><span>Заметка</span>
                        <input data-hotel-note="${i}" value="${esc(h.note || '')}">
                    </label>
                </div>`).join('') +
                '<button type="button" class="page-save-btn" onclick="saveHotelsPage()">Сохранить страницу</button></div>';
        }
        window.saveHotelsPage = function saveHotelsPage() {
            if (!currentPlanJson) return;
            currentPlanJson.hotels = (currentPlanJson.hotels || []).map((h, i) => {
                const inp = document.querySelector('[data-hotel-note="' + i + '"]');
                return { ...h, note: inp ? inp.value : h.note };
            });
            persistPlanDebounced();
            showSaveToast('Страница отелей сохранена');
        };

        function renderTipsPage() {
            const panel = document.getElementById('roamyPanelTips');
            if (!panel) return;
            const tips = (currentPlanJson && currentPlanJson.tips) || [];
            const extra = panel.querySelector('#tripInfo');
            const editor = document.getElementById('tipsPageEditor') || document.createElement('div');
            editor.id = 'tipsPageEditor';
            editor.className = 'page-editor';
            editor.innerHTML = '<h3>Лайфхаки</h3><p class="page-editor-sub">Отдельная страница советов по городу.</p>' +
                tips.map((t, i) => `<div class="tip-row">
                    <label class="page-field"><span>Категория</span><input data-tip-cat="${i}" value="${esc(t.category || '')}"></label>
                    <label class="page-field"><span>Текст</span><textarea data-tip-text="${i}">${esc(t.text || '')}</textarea></label>
                </div>`).join('') +
                '<button type="button" class="page-save-btn" onclick="saveTipsPage()">Сохранить страницу</button>';
            if (!editor.parentNode) panel.insertBefore(editor, extra || null);
        }
        window.saveTipsPage = function saveTipsPage() {
            if (!currentPlanJson) return;
            currentPlanJson.tips = (currentPlanJson.tips || []).map((t, i) => {
                const cat = document.querySelector('[data-tip-cat="' + i + '"]');
                const text = document.querySelector('[data-tip-text="' + i + '"]');
                return { category: cat ? cat.value : t.category, text: text ? text.value : t.text };
            });
            persistPlanDebounced();
            showSaveToast('Страница лайфхаков сохранена');
        };

        window.saveBudgetPage = function saveBudgetPage() {
            if (!currentPlanJson) return;
            currentPlanJson.dailyBudget = currentPlanJson.dailyBudget || {};
            document.querySelectorAll('[data-budget]').forEach((inp) => {
                currentPlanJson.dailyBudget[inp.getAttribute('data-budget')] = inp.value;
            });
            persistPlanDebounced();
            showSaveToast('Страница бюджета сохранена');
        };

        function tripOrigin() {
            if (destCoords && Number.isFinite(Number(destCoords.lat))) {
                return { lat: Number(destCoords.lat), lon: Number(destCoords.lon) };
            }
            const live = (currentPlaceInfo || []).find((x) => Number.isFinite(Number(x.lat)));
            if (live) return { lat: Number(live.lat), lon: Number(live.lon) };
            for (const d of planDays || []) {
                const jp = (d.jsonPlaces || []).find((x) => Number.isFinite(Number(x.lat)));
                if (jp) return { lat: Number(jp.lat), lon: Number(jp.lon) };
            }
            const days = (currentPlanJson && currentPlanJson.days) || [];
            for (const d of days) {
                const jp = (d.places || []).find((x) => Number.isFinite(Number(x.lat)));
                if (jp) return { lat: Number(jp.lat), lon: Number(jp.lon) };
            }
            return null;
        }

        async function openAddPlaceDrawer() {
            const ov = document.getElementById('addPlaceOverlay');
            if (ov) ov.classList.add('open');
            const list = document.getElementById('apList');
            if (list) list.innerHTML = '<div class="ap-sub">Загружаю точки рядом…</div>';
            const origin = tripOrigin();
            if (!origin) {
                if (list) list.innerHTML = '<div class="ap-sub">Сначала постройте маршрут.</div>';
                return;
            }
            try {
                const dest = encodeURIComponent(tripData.destination || tripData.city || '');
                const resp = await fetch('/api/catalog?lat=' + origin.lat + '&lon=' + origin.lon + '&city=' + dest);
                const data = await resp.json();
                const taken = new Set((currentPlaceInfo || []).map((p) => (p.name || '').toLowerCase()));
                const pois = (data.pois || []).filter((p) => !taken.has(String(p.name || '').toLowerCase())).slice(0, 18);
                if (!pois.length) {
                    list.innerHTML = '<div class="ap-sub">Рядом ничего не нашлось — введите название вручную.</div>';
                    return;
                }
                list.innerHTML = pois.map((p) => `<button type="button" class="ap-item" data-name="${esc(p.name)}" data-lat="${p.lat}" data-lon="${p.lon}" data-kind="${esc(p.kind || '')}" data-address="${esc(p.address || '')}">
                    <b>${esc(p.name)}</b><span>${esc(p.kind || 'место')} · ${esc(p.address || '')}</span>
                </button>`).join('');
                list.querySelectorAll('.ap-item').forEach((btn) => {
                    btn.onclick = () => addPlaceFromCatalog({
                        name: btn.dataset.name,
                        lat: Number(btn.dataset.lat),
                        lon: Number(btn.dataset.lon),
                        kind: btn.dataset.kind,
                        address: btn.dataset.address,
                    });
                });
            } catch (e) {
                if (list) list.innerHTML = '<div class="ap-sub">Не удалось загрузить каталог.</div>';
            }
        }
        window.openAddPlaceDrawer = openAddPlaceDrawer;
        function closeAddPlaceDrawer() {
            document.getElementById('addPlaceOverlay')?.classList.remove('open');
        }
        window.closeAddPlaceDrawer = closeAddPlaceDrawer;

        async function addPlaceFromCatalog(p) {
            const dayIndex = currentDayIndex || 0;
            if (!p || !p.name) return;
            if ((currentPlaceInfo || []).some((x) => (x.name || '').toLowerCase() === p.name.toLowerCase())) {
                showSaveToast('Это место уже в дне');
                return;
            }
            currentPlaceInfo.push({
                num: currentPlaceInfo.length + 1,
                name: p.name,
                lat: p.lat,
                lon: p.lon,
                kind: p.kind,
                address: p.address,
            });
            writePlacesBack(dayIndex, currentPlaceInfo);
            closeAddPlaceDrawer();
            await redrawMapFromCurrentPlaces(dayIndex);
        }

        async function submitAddPlaceSearch() {
            const q = (document.getElementById('apSearch')?.value || '').trim();
            if (!q) return;
            const geoBody = { place: q, destination: tripData.destination || '' };
            if (destCoords) { geoBody.destLat = destCoords.lat; geoBody.destLon = destCoords.lon; }
            try {
                const resp = await fetch('/api/geocode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(geoBody),
                });
                const data = await resp.json();
                if (!data.success) {
                    showSaveToast('Место не найдено');
                    return;
                }
                await addPlaceFromCatalog({ name: q, lat: data.lat, lon: data.lon, address: data.address || '' });
            } catch (e) {
                showSaveToast('Ошибка поиска');
            }
        }
        window.submitAddPlaceSearch = submitAddPlaceSearch;
        window.addCustomPlacePrompt = openAddPlaceDrawer;

        function clearActiveTrip() {
            try { sessionStorage.removeItem(TB_ACTIVE_KEY); } catch (e) {}
        }

        function resetToStart() {
            clearActiveTrip();
            stopLoadingAnimation();
            document.body.classList.remove('result-mode', 'loading-mode');
            const result = document.getElementById('result');
            if (result) result.classList.add('hidden');
            const loading = document.getElementById('loading');
            if (loading) loading.classList.add('hidden');
            document.getElementById('step2')?.classList.add('hidden');
            document.getElementById('step3')?.classList.add('hidden');
            document.getElementById('screenTrips')?.classList.add('hidden');
            document.getElementById('screenPricing')?.classList.add('hidden');
            document.getElementById('screenCabinet')?.classList.add('hidden');
            document.getElementById('step1')?.classList.remove('hidden');
            if (typeof currentMainTab !== 'undefined') currentMainTab = 'home';
            document.querySelectorAll('.main-tab-btn').forEach((b) => {
                b.classList.toggle('is-active', b.getAttribute('data-main-tab') === 'home');
            });
            try { history.replaceState(null, '', location.pathname); } catch (e) {}
            const indicator = document.getElementById('stepIndicator');
            if (indicator) {
                indicator.classList.remove('hidden');
                indicator.style.display = '';
            }
            const progressFill = document.getElementById('stepProgressFill');
            if (progressFill && progressFill.parentElement) {
                progressFill.parentElement.style.display = '';
            }
            const bottomTabs = document.getElementById('bottomTabs');
            if (bottomTabs) bottomTabs.style.display = 'none';
            currentStep = 1;
            planDays = [];
            currentPlanText = '';
            currentPlanJson = null;
            currentTripId = null;
            destCoords = null;
            updateStepIndicator(1);
            if (tripData.city && tripData.country) {
                const uni = document.getElementById('unifiedSearchInput');
                if (uni) {
                    uni.value = `${tripData.city}, ${tripData.country}`;
                    const wrap = uni.closest('.s1-unified-wrap');
                    if (wrap) wrap.classList.add('has-value');
                }
                const cityInput = document.getElementById('cityInput');
                const countryInput = document.getElementById('countryInput');
                if (cityInput) cityInput.value = tripData.city;
                if (countryInput) countryInput.value = tripData.country;
                if (typeof showSelectedChip === 'function') showSelectedChip(tripData.city, tripData.country, '🌍');
                if (typeof updateNextButton === 'function') updateNextButton();
            }
            window.scrollTo({ top: 0, behavior: 'auto' });
            if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
        }
        window.resetToStart = resetToStart;

        function buildClientFallback(reason) {
            const dest = tripData.destination || tripData.city || 'Город';
            const days = Math.max(1, Math.min(2, Number(tripData.daysCount) || 2));
            const planJson = {
                destination: dest,
                country: tripData.country || '',
                theme: tripData.tripType || 'Популярные места',
                days: Array.from({ length: days }, (_, i) => ({
                    day: i + 1,
                    district: i === 0 ? 'Исторический центр' : 'Набережная',
                    places: [
                        { name: `Главная площадь — ${dest}`, address: dest, timeStart: '09:00', timeEnd: '10:30', description: 'Точка старта пешего дня.', price: 'бесплатно' },
                        { name: 'Городской музей или собор', address: dest, timeStart: '10:45', timeEnd: '12:30', description: 'Короткий переход и спокойный осмотр.', price: 'входной билет' },
                        { name: 'Кафе на обед', address: dest, timeStart: '12:45', timeEnd: '14:00', description: 'Местное место без туристического меню.', price: 'средний чек' },
                        { name: 'Набережная или смотровая', address: dest, timeStart: '16:20', timeEnd: '18:00', description: 'Золотой час и фото.', price: 'бесплатно' },
                    ],
                })),
            };
            return {
                success: true,
                plan: `День 1 — ${dest}\n\n1. ГЛАВНАЯ ПЛОЩАДЬ\nВремя: 09:00-10:30\nОписание: Точка старта пешего дня.\n\nДень 2 — ${dest}\n\n1. НАБЕРЕЖНАЯ ИЛИ СМОТРОВАЯ\nВремя: 09:00-10:30\nОписание: Второй день в соседнем районе.`,
                planJson,
                coords: destCoords,
                access: { subscribed: false, freeDays: 2, requestedDays: Number(tripData.daysCount) || days, visibleDays: days, cached: false },
                fallbackReason: reason || 'offline',
            };
        }

        function dayContentFromPlaces(places) {
            return (places || []).map((p, i) => {
                const name = String(p.name || '').toUpperCase();
                const addr = p.address ? ` (${p.address})` : '';
                const time = (p.timeStart || p.timeEnd) ? `\nВремя: ${p.timeStart || ''}–${p.timeEnd || ''}` : '';
                const desc = p.description ? `\nОписание: ${p.description}` : '';
                const price = p.price ? `\nЦена: ${p.price}` : '';
                return `${i + 1}. ${name}${addr}${time}${desc}${price}`;
            }).join('\n\n');
        }

        // Убирает служебные строки «День N» из текста дня — они больше не выводятся списком
        function stripDayHeadersFromContent(content) {
            return String(content || '')
                .split('\n')
                .map((line) => {
                    const t = line.trim();
                    // Голый заголовок «День 2» — удаляем целиком
                    if (/^День\s+\d+\s*$/.test(t)) return null;
                    // «День 2 — Храмы и монастыри» → оставляем смысловую часть
                    return line.replace(/^\s*День\s+\d+\s*(—|–|-|:)\s*/, '');
                })
                .filter((line) => line !== null)
                .join('\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        }

        function renderDayButtons() {
            const tripInfoDiv = document.getElementById('tripInfo');
            if (tripInfoDiv) tripInfoDiv.innerHTML = '';
            const buttonsDiv = document.getElementById('dayButtons');
            if (!buttonsDiv) return;
            buttonsDiv.innerHTML = '';
            const startDate = tripData.dateStart ? new Date(tripData.dateStart) : null;
            const monthNames = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
            planDays.forEach((day, idx) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'day-btn' + (idx === 0 ? ' active' : '') + (day.locked ? ' locked' : '');
                const dot = document.createElement('span');
                dot.className = 'day-color-dot';
                dot.style.background = dayColors[idx % dayColors.length];
                btn.appendChild(dot);
                const dayLabel = document.createElement('span');
                dayLabel.textContent = `День ${day.dayNum}`;
                btn.appendChild(dayLabel);
                if (day.locked) {
                    const lock = document.createElement('span');
                    lock.className = 'day-lock';
                    lock.textContent = 'Plus';
                    btn.appendChild(lock);
                } else if (startDate) {
                    const d = new Date(startDate);
                    d.setDate(d.getDate() + idx);
                    const dateSpan = document.createElement('span');
                    dateSpan.className = 'day-date';
                    dateSpan.textContent = `${d.getDate()} ${monthNames[d.getMonth()]}`;
                    btn.appendChild(dateSpan);
                }
                btn.onclick = () => selectDay(idx);
                buttonsDiv.appendChild(btn);
            });
        }

        function applyStructuredPlan(planJson) {
            if (!planJson || !Array.isArray(planJson.days) || planJson.days.length === 0) return false;
            planDays = planJson.days.map((d) => ({
                dayNum: d.day || 0,
                content: stripDayHeadersFromContent(dayContentFromPlaces(d.places)),
                jsonPlaces: Array.isArray(d.places) ? d.places : [],
                locked: false,
            }));
            renderDayButtons();
            if (planDays.length > 0) loadAllDaysOnMap();
            return true;
        }

        function processApiResult(data) {
            persistActiveTrip(data || {});
            showResultView();

            const dest = tripData.destination || tripData.city || '';
            const rtbCity = document.getElementById('rtbCity');
            if (rtbCity) rtbCity.textContent = dest || 'Маршрут';
            const sheetDest = document.getElementById('sheetDestName');
            if (sheetDest) sheetDest.textContent = dest || 'Маршрут';
            const rtbMeta = document.getElementById('rtbMeta');
            if (rtbMeta) {
                const parts = [];
                if (tripData.daysCount || tripData.days) {
                    const n = Number(tripData.daysCount || tripData.days);
                    parts.push(n + ' ' + (n == 1 ? 'день' : n < 5 ? 'дня' : 'дней'));
                }
                if (tripData.travelers) parts.push(tripData.travelers + ' ' + (tripData.travelers == 1 ? 'человек' : tripData.travelers < 5 ? 'человека' : 'человек'));
                const src = (data && data.source) || window.__tbSource;
                if (src === 'search') parts.push('по карте OSM');
                else if (src === 'cache') parts.push('из кэша');
                rtbMeta.textContent = parts.join(' · ');
            }
            setTimeout(() => {
                try { if (leafletMap) leafletMap.invalidateSize(true); } catch(e) {}
                if (window._sheet) window._sheet.snapTo(window._sheet.SNAP.MID, true);
            }, 420);

            try { showWishesBanner(); } catch (e) { console.warn(e); }

            destCoords = data.coords || destCoords || null;
            currentPlanText = data.plan || currentPlanText || '';
            currentPlanJson = data.planJson || currentPlanJson || null;
            currentTripId = data.tripId || currentTripId || null;
            window.__tbTripId = currentTripId;
            const favBtn = document.getElementById('rtbFavBtn');
            const destKey = String(tripData.destination || tripData.city || '').toLowerCase();
            if (favBtn) favBtn.classList.toggle('is-on', tbFavHas('trip', destKey));
            window.__tbPages = data.pages || window.__tbPages || null;
            window.__tbSource = data.source || window.__tbSource || null;
            if (destCoords && tripMode === 'dates') {
                try { fetchWeather(destCoords.lat, destCoords.lon); } catch (e) {}
            } else {
                const weatherStrip = document.getElementById('weatherStrip');
                const weatherLabel = document.getElementById('weatherLabel');
                if (weatherStrip) weatherStrip.style.display = 'none';
                if (weatherLabel) weatherLabel.style.display = 'none';
            }

            try {
                if (!applyStructuredPlan(data.planJson)) {
                    parsePlanDays(data.plan || '');
                }
            } catch (parseErr) {
                console.error('parsePlanDays error:', parseErr);
                const mapSection = document.getElementById('mapSection');
                if (mapSection) mapSection.classList.remove('hidden');
                const dtEl = document.getElementById('dayText');
                if (dtEl) {
                    dtEl.style.display = 'block';
                    dtEl.innerHTML = formatDayContent(data.plan || 'План не удалось обработать');
                }
            }

            window.__tbAccess = data.access || { subscribed: true, freeDays: 2, requestedDays: 0, visibleDays: 99, cached: false };
            try { if (typeof applyAccessToDays === 'function') applyAccessToDays(window.__tbAccess); } catch (e) { console.warn('applyAccessToDays:', e); }
            try { renderStructuredPages(); } catch (e) {}

            if (planDays.length === 0 && (data.plan || '').trim()) {
                const mapSection = document.getElementById('mapSection');
                if (mapSection) mapSection.classList.remove('hidden');
                const dayTextEl = document.getElementById('dayText');
                if (dayTextEl) {
                    dayTextEl.style.display = 'block';
                    dayTextEl.innerHTML = formatDayContent(data.plan);
                }
            }

            try { fetchFlightsAndHotels(); } catch (e) { console.warn(e); }
        }

        function stopLoadingAnimation() {
            clearTimeout(lsStepTimer);
            clearTimeout(lsCompleteTimer);
            clearInterval(lsFactTimer);
            lsAnimFinished = true;
        }


        function showConfetti() {
            const container = document.getElementById('confettiContainer');
            container.innerHTML = '';
            container.style.display = 'block';
            const colors = ['#005F60', '#3C2433', '#2D68C4', '#267D7E', '#5B8DD9'];
            const btn = document.getElementById('generateBtn');
            const rect = btn.getBoundingClientRect();
            const originX = rect.left + rect.width / 2;
            const originY = rect.top + rect.height / 2;
            for (let i = 0; i < 30; i++) {
                const p = document.createElement('div');
                p.className = 'confetti-particle';
                p.style.left = originX + 'px';
                p.style.top = originY + 'px';
                p.style.backgroundColor = colors[i % 5];
                p.style.setProperty('--cx', ((Math.random() - 0.5) * 400) + 'px');
                p.style.setProperty('--cy', ((Math.random() - 0.5) * 600) + 'px');
                p.style.setProperty('--cr', (Math.random() * 720 - 360) + 'deg');
                p.style.animationDelay = (Math.random() * 0.15) + 's';
                container.appendChild(p);
            }
            setTimeout(() => { container.style.display = 'none'; container.innerHTML = ''; }, 1200);
        }

        function openPaywall() {
            const el = document.getElementById('tbPaywall');
            if (el) el.classList.remove('hidden');
        }
        function closePaywall() {
            const el = document.getElementById('tbPaywall');
            if (el) el.classList.add('hidden');
        }
        window.openPaywall = openPaywall;
        window.closePaywall = closePaywall;

        function applyAccessToDays(access) {
            if (!access || access.subscribed) return;
            const requested = Number(access.requestedDays) || Number(tripData.daysCount) || Number(tripData.days) || planDays.length;
            const freeDays = Number(access.freeDays) || 2;
            while (planDays.length < requested) {
                planDays.push({ dayNum: planDays.length + 1, content: '', locked: true });
            }
            planDays.forEach((d, i) => {
                if (i >= freeDays) d.locked = true;
            });
            const buttonsDiv = document.getElementById('dayButtons');
            if (!buttonsDiv) return;
            const startDate = tripData.dateStart ? new Date(tripData.dateStart) : null;
            const monthNames = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
            buttonsDiv.innerHTML = '';
            planDays.forEach((day, idx) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'day-btn' + (idx === 0 ? ' active' : '') + (day.locked ? ' locked' : '');
                const dot = document.createElement('span');
                dot.className = 'day-color-dot';
                dot.style.background = dayColors[idx % dayColors.length];
                btn.appendChild(dot);
                const dayLabel = document.createElement('span');
                dayLabel.textContent = 'День ' + day.dayNum;
                btn.appendChild(dayLabel);
                if (day.locked) {
                    const lock = document.createElement('span');
                    lock.className = 'day-lock';
                    lock.textContent = 'Plus';
                    btn.appendChild(lock);
                } else if (startDate) {
                    const d = new Date(startDate);
                    d.setDate(d.getDate() + idx);
                    const dateSpan = document.createElement('span');
                    dateSpan.className = 'day-date';
                    dateSpan.textContent = d.getDate() + ' ' + monthNames[d.getMonth()];
                    btn.appendChild(dateSpan);
                }
                btn.onclick = function() { selectDay(idx); };
                buttonsDiv.appendChild(btn);
            });
        }

        async function generatePlan() {

            readBudgetInputs();
            if (!tripData.budget) {
                alert('Укажи бюджет');
                return;
            }
            if (!tripData.travelers) {
                alert('Укажи количество человек');
                return;
            }
            if (!tripData.tripType || selectedTripTypes.length === 0) {
                alert('Выбери хотя бы один тип путешествия');
                return;
            }
            const wishesVal = (document.getElementById('wishesInput')?.value || '').trim();
            if (wishesVal) {
                tripData.wishes = wishesVal;
            } else {
                delete tripData.wishes;
            }

            showLoadingView();

            const controller = new AbortController();
            const kill = setTimeout(() => controller.abort(), 22000);
            try {
                const tgUser = tg?.initDataUnsafe?.user || {};
                const response = await fetch('/api/generate', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        ...tripData,
                        region: travelRegion,
                        destination: travelRegion === 'russia' && tripData.destination && !/росси/i.test(tripData.destination)
                            ? tripData.destination + ', Россия'
                            : tripData.destination,
                        userId: tgUser.id || 'anonymous',
                        username: tgUser.username || null,
                        firstName: tgUser.first_name || null,
                        lastName: tgUser.last_name || null,
                        languageCode: tgUser.language_code || null
                    }),
                    signal: controller.signal,
                });

                let data = null;
                try {
                    data = await response.json();
                } catch (parseErr) {
                    data = { success: false, error: 'bad_response' };
                }

                if (!response.ok || !data.success || !(data.plan || data.planJson)) {
                    console.warn('Generate API failed, using fallback', response.status, data);
                    onApiComplete(buildClientFallback(data.error || data.message || ('HTTP ' + response.status)));
                    return;
                }

                persistActiveTrip(data);
                onApiComplete(data);

            } catch (error) {
                console.error('Generate error:', error);
                onApiComplete(buildClientFallback(error.message || error));
            } finally {
                clearTimeout(kill);
            }
        }
        window.generatePlan = generatePlan;

        // ── Premium error toast вместо alert() ──
        function showGenError({icon='⚠️', title='Ошибка', text='', hint=''}) {
            const old = document.getElementById('genErrorToast');
            if (old) old.remove();
            const toast = document.createElement('div');
            toast.id = 'genErrorToast';
            toast.innerHTML =
                `<div class="ge-card">
                    <div class="ge-icon">${icon}</div>
                    <div class="ge-title">${title}</div>
                    <div class="ge-text">${text}</div>
                    ${hint ? `<div class="ge-hint">${hint}</div>` : ''}
                    <button class="ge-close" onclick="this.closest('#genErrorToast').remove()">Понятно</button>
                </div>`;
            document.body.appendChild(toast);
            setTimeout(() => { if (toast.parentNode) toast.remove(); }, 8000);
            if (typeof tg !== 'undefined' && tg?.HapticFeedback) {
                tg.HapticFeedback.notificationOccurred('error');
            }
        }

        // ===========================================================
        // TRAVELPAYOUTS — АВИАБИЛЕТЫ И ОТЕЛИ
        // ===========================================================

        function formatPrice(price, currency) {
            if (!price && price !== 0) return '—';
            const symbols = { rub: '₽', usd: '$', eur: '€' };
            const sym = symbols[currency] || currency.toUpperCase();
            return price.toLocaleString('ru-RU') + ' ' + sym;
        }

        function formatDuration(mins) {
            if (!mins) return '';
            const h = Math.floor(mins / 60);
            const m = mins % 60;
            return h > 0 ? `${h}ч ${m}м` : `${m}м`;
        }

        function formatFlightDate(isoStr) {
            if (!isoStr) return '';
            try {
                const d = new Date(isoStr);
                return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
            } catch { return isoStr.slice(0, 10); }
        }

        // ── Город отправления (определяется по IP) ──
        let userOriginIata = '';
        let userOriginName = '';

        async function detectUserCity() {
            try {
                const resp = await fetch('/api/geoip');
                const data = await resp.json();
                if (data.success && data.iata) {
                    userOriginIata = data.iata;
                    userOriginName = data.name || '';
                    const input = document.getElementById('originCityInput');
                    if (input) input.value = userOriginName;
                    const badge = document.getElementById('originIataBadge');
                    if (badge) {
                        badge.textContent = userOriginIata;
                        badge.style.display = 'inline';
                    }
                    const detecting = document.getElementById('originDetecting');
                    if (detecting) detecting.style.display = 'none';
                    console.log('GeoIP:', userOriginName, userOriginIata);
                } else {
                    const detecting = document.getElementById('originDetecting');
                    if (detecting) detecting.textContent = '';
                    const input = document.getElementById('originCityInput');
                    if (input) input.placeholder = 'Введите город вылета...';
                }
            } catch (e) {
                console.warn('GeoIP failed:', e);
                const detecting = document.getElementById('originDetecting');
                if (detecting) detecting.textContent = '';
                const input = document.getElementById('originCityInput');
                if (input) input.placeholder = 'Введите город вылета...';
            }
        }

        // Обработка ручного ввода города отправления
        let originInputTimer = null;
        // Сохраняем данные IATA назначения для повторных запросов
        let destIataData = null;

        // Форматирование даты для отображения
        function formatDateShort(dateStr) {
            if (!dateStr) return '';
            try {
                const d = new Date(dateStr + 'T00:00:00');
                return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
            } catch { return dateStr; }
        }

        // Обновление подзаголовка с городом и датами
        function updateBookingSubtitle(destName, destIata) {
            const originLabel = userOriginName ? `из ${userOriginName} ` : '';
            const depDate = tripData.dateStart || '';
            const retDate = tripData.dateEnd || '';
            let dateLabel = '';
            if (depDate) {
                dateLabel = ' · ' + formatDateShort(depDate);
                if (retDate) dateLabel += ' – ' + formatDateShort(retDate);
            }
            document.getElementById('bookingPanelSubtitle').textContent =
                `${originLabel}→ ${destName} (${destIata})${dateLabel}`;
        }

        __tbReady(() => {
            const originInput = document.getElementById('originCityInput');
            if (originInput) {
                originInput.addEventListener('input', () => {
                    clearTimeout(originInputTimer);
                    const badge = document.getElementById('originIataBadge');
                    badge.style.display = 'none';
                    userOriginIata = '';
                    originInputTimer = setTimeout(async () => {
                        const val = originInput.value.trim();
                        if (val.length < 2) return;
                        try {
                            const resp = await fetch('/api/iata', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({ city: val })
                            });
                            const data = await resp.json();
                            if (data.success && data.code) {
                                userOriginIata = data.code;
                                userOriginName = data.name || val;
                                badge.textContent = userOriginIata;
                                badge.style.display = 'inline';
                                // Автоматически обновляем если план уже загружен
                                if (document.getElementById('bottomTabs').style.display !== 'none') {
                                    refreshBooking();
                                }
                            }
                        } catch (e) { console.warn('Origin IATA failed:', e); }
                    }, 600);
                });
            }
        });

        async function fetchFlightsAndHotels() {
            const city = tripData.city || tripData.destination || '';
            if (!city) return;

            // Показываем блок с табами и активируем маршрут по умолчанию
            document.getElementById('bottomTabs').style.display = '';
            // Default: route tab is active
            switchRoamyTab('wishes');
            const bookingLinks = document.getElementById('bookingLinks');
            bookingLinks.innerHTML = '<div class="booking-loading">✈️ Подбираем предложения...</div>';

            // 1) Получаем IATA-код города назначения
            let destIata = '';
            let destName = city.split(',')[0].trim();
            let citySlug = '';
            let countrySlug = '';
            try {
                const iataResp = await fetch('/api/iata', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ city: destName })
                });
                const iataData = await iataResp.json();
                if (iataData.success && iataData.code) {
                    destIata = iataData.code;
                    destName = iataData.name || destName;
                    citySlug = iataData.city_slug || '';
                    countrySlug = iataData.country_slug || '';
                    destIataData = iataData;
                    updateBookingSubtitle(destName, destIata);
                }
            } catch (e) {
                console.warn('IATA lookup failed:', e);
            }

            if (!destIata) {
                bookingLinks.innerHTML = '<div class="booking-empty">Город не найден в базе</div>';
                return;
            }

            // Определяем даты
            const depDate = tripData.dateStart || '';
            const retDate = tripData.dateEnd || '';

            // 2) Параллельно запрашиваем авиабилеты и отели
            // Используем валюту, выбранную пользователем
            const bookingCurrency = (tripData.currencyCode || selectedCurrencyCode || 'USD').toLowerCase();

            const flightsPromise = fetch('/api/flights', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    destination: destIata,
                    origin: userOriginIata || '',
                    departureDate: depDate ? depDate.slice(0, 7) : '',
                    returnDate: retDate ? retDate.slice(0, 7) : '',
                    currency: bookingCurrency
                })
            }).then(r => r.json()).catch(() => null);

            const hotelsPromise = fetch('/api/hotels', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    location: destName,
                    iata: destIata || '',
                    cityName: destName,
                    city_slug: citySlug,
                    country_slug: countrySlug,
                    checkIn: depDate || '',
                    checkOut: retDate || '',
                    currency: bookingCurrency
                })
            }).then(r => r.json()).catch(() => null);

            const [flightsResult, hotelsResult] = await Promise.all([flightsPromise, hotelsPromise]);

            // 3) Отрисовываем всё в единый список
            renderBookingLinks(flightsResult, hotelsResult);
        }

        // Обновление бронирования (при смене города отправления)
        async function refreshBooking() {
            const city = tripData.city || tripData.destination || '';
            if (!city) return;
            const bookingLinks = document.getElementById('bookingLinks');
            bookingLinks.innerHTML = '<div class="booking-loading">✈️ Обновляем предложения...</div>';

            let destIata = destIataData ? destIataData.code : '';
            let destName = destIataData ? destIataData.name : city.split(',')[0].trim();
            let citySlug = destIataData ? destIataData.city_slug : '';
            let countrySlug = destIataData ? destIataData.country_slug : '';

            if (!destIata) {
                try {
                    const iataResp = await fetch('/api/iata', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ city: destName })
                    });
                    const iataData = await iataResp.json();
                    if (iataData.success && iataData.code) {
                        destIata = iataData.code;
                        destName = iataData.name || destName;
                        citySlug = iataData.city_slug || '';
                        countrySlug = iataData.country_slug || '';
                        destIataData = iataData;
                    }
                } catch (e) { /* ignore */ }
            }

            if (!destIata) {
                bookingLinks.innerHTML = '<div class="booking-empty">Город не найден</div>';
                return;
            }

            updateBookingSubtitle(destName, destIata);

            const depDate = tripData.dateStart || '';
            const retDate = tripData.dateEnd || '';

            const refreshCurrency = (tripData.currencyCode || selectedCurrencyCode || 'USD').toLowerCase();

            try {
                const [flightsResult, hotelsResult] = await Promise.all([
                    fetch('/api/flights', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            destination: destIata,
                            origin: userOriginIata || '',
                            departureDate: depDate ? depDate.slice(0, 7) : '',
                            returnDate: retDate ? retDate.slice(0, 7) : '',
                            currency: refreshCurrency
                        })
                    }).then(r => r.json()).catch(() => null),
                    fetch('/api/hotels', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            location: destName,
                            iata: destIata,
                            cityName: destName,
                            city_slug: citySlug,
                            country_slug: countrySlug,
                            checkIn: depDate || '',
                            checkOut: retDate || '',
                            currency: refreshCurrency
                        })
                    }).then(r => r.json()).catch(() => null)
                ]);
                renderBookingLinks(flightsResult, hotelsResult);
            } catch (e) {
                bookingLinks.innerHTML = '<div class="booking-empty">Ошибка загрузки</div>';
            }
        }

        // Travelpayouts партнёрский маркер для реферальных ссылок (должен совпадать с server.py)
        const TP_MARKER = '705270';

        // Оборачивает любой URL в реферальную ссылку tp.media
        function tpAffiliateLink(rawUrl, source = 'aero') {
            return `https://tp.media/r?marker=${TP_MARKER}&trs=travelbase&p=4&s=${source}&u=${encodeURIComponent(rawUrl)}`;
        }

        // Build Aviasales search link with user data pre-filled (реферальная)
        function buildAviasalesLink(flight) {
            const origin = flight.origin || userOriginIata || '';
            const dest = flight.destination || (destIataData ? destIataData.code : '');
            let rawUrl;
            
            // If we have a link token from the API, use it (it already has all data)
            if (flight.link) {
                rawUrl = `https://www.aviasales.ru${flight.link}`;
            } else if (origin && dest) {
                // Fallback: build manual search URL
                rawUrl = `https://www.aviasales.ru/search/${origin}`;
                
                // Add departure date (DDMM)
                if (flight.departure_at) {
                    const d = new Date(flight.departure_at);
                    const dd = String(d.getDate()).padStart(2, '0');
                    const mm = String(d.getMonth() + 1).padStart(2, '0');
                    rawUrl += dd + mm;
                }
                
                rawUrl += dest;
                
                // Add return date (DDMM) 
                if (flight.return_at) {
                    const d = new Date(flight.return_at);
                    const dd = String(d.getDate()).padStart(2, '0');
                    const mm = String(d.getMonth() + 1).padStart(2, '0');
                    rawUrl += dd + mm;
                }
                
                // Passengers count
                rawUrl += (tripData.travelers || '1');
            } else {
                rawUrl = `https://www.aviasales.ru/search/${dest || origin || ''}`;
            }
            
            // Оборачиваем в реферальную ссылку
            return tpAffiliateLink(rawUrl, 'aero');
        }

        function renderBookingLinks(flightsData, hotelsData) {
            const container = document.getElementById('bookingLinks');
            let html = '';

            // --- Авиабилеты (лучшее предложение) ---
            if (flightsData && flightsData.success && flightsData.flights && flightsData.flights.length > 0) {
                html += `<div style="font-size:12px; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; padding:0 2px 4px;">Авиабилеты</div>`;
                const f = flightsData.flights[0]; // самый дешёвый
                const currency = flightsData.currency || 'rub';
                const depDate = formatFlightDate(f.departure_at);
                const retDate = f.return_at ? formatFlightDate(f.return_at) : '';
                const transfers = f.transfers === 0 ? 'Прямой' : (f.transfers === 1 ? '1 пересадка' : `${f.transfers} пересадки`);
                const aviasalesLink = buildAviasalesLink(f);
                const dateStr = depDate + (retDate ? ' — ' + retDate : '');

                html += `
                <a class="booking-link" href="${aviasalesLink}" target="_blank" rel="noopener">
                    <div class="bl-icon bl-icon-flights">${bookingSvgIcons.flights}</div>
                    <div class="bl-info">
                        <div class="bl-name">Авиабилеты</div>
                        <div class="bl-desc">${transfers} · ${dateStr}</div>
                    </div>
                    <div class="bl-price">${formatPrice(f.price, currency)}</div>
                    <div class="bl-arrow">›</div>
                </a>`;

                // Если есть больше предложений, показываем ещё до 2
                for (let i = 1; i < Math.min(flightsData.flights.length, 3); i++) {
                    const fi = flightsData.flights[i];
                    const fiDep = formatFlightDate(fi.departure_at);
                    const fiRet = fi.return_at ? formatFlightDate(fi.return_at) : '';
                    const fiTransfers = fi.transfers === 0 ? 'Прямой' : (fi.transfers === 1 ? '1 пересадка' : `${fi.transfers} пересадки`);
                    const fiLink = buildAviasalesLink(fi);
                    const fiDate = fiDep + (fiRet ? ' — ' + fiRet : '');
                    html += `
                    <a class="booking-link" href="${fiLink}" target="_blank" rel="noopener">
                        <div class="bl-icon bl-icon-flights">${bookingSvgIcons.flights}</div>
                        <div class="bl-info">
                            <div class="bl-name">${fi.airline || 'Авиабилет'}</div>
                            <div class="bl-desc">${fiTransfers} · ${fiDate}</div>
                        </div>
                        <div class="bl-price">${formatPrice(fi.price, currency)}</div>
                        <div class="bl-arrow">›</div>
                    </a>`;
                }
            } else {
                // No flights found — but still show clickable link to Aviasales search
                html += `<div style="font-size:12px; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; padding:0 2px 4px;">Авиабилеты</div>`;
                const destCode = destIataData ? destIataData.code : '';
                const originCode = userOriginIata || '';
                let fallbackRaw = 'https://www.aviasales.ru';
                if (originCode && destCode) {
                    let u = `/search/${originCode}`;
                    if (tripData.dateStart) {
                        const d = new Date(tripData.dateStart);
                        u += String(d.getDate()).padStart(2,'0') + String(d.getMonth()+1).padStart(2,'0');
                    }
                    u += destCode;
                    if (tripData.dateEnd) {
                        const d = new Date(tripData.dateEnd);
                        u += String(d.getDate()).padStart(2,'0') + String(d.getMonth()+1).padStart(2,'0');
                    }
                    u += (tripData.travelers || '1');
                    fallbackRaw += u;
                } else if (destCode) {
                    fallbackRaw += `/search/${destCode}`;
                }
                const fallbackUrl = tpAffiliateLink(fallbackRaw, 'aero');
                
                html += `
                <a class="booking-link" href="${fallbackUrl}" target="_blank" rel="noopener">
                    <div class="bl-icon bl-icon-flights">${bookingSvgIcons.flights}</div>
                    <div class="bl-info">
                        <div class="bl-name">Искать авиабилеты</div>
                        <div class="bl-desc">Найти на Aviasales →</div>
                    </div>
                    <div class="bl-arrow">›</div>
                </a>`;
            }

            // --- Отели (3 сервиса) ---
            if (hotelsData && hotelsData.success && hotelsData.links && hotelsData.links.length > 0) {
                html += `<div style="font-size:12px; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; padding:8px 2px 4px;">Отели</div>`;
                const cityName = hotelsData.cityName || 'город';
                const depDate = tripData.dateStart || '';
                const retDate = tripData.dateEnd || '';
                const datesStr = depDate ? ` · ${formatDateShort(depDate)}${retDate ? ' – ' + formatDateShort(retDate) : ''}` : '';
                const iconMap = {
                    'Hotellook': 'bl-icon-hotellook',
                    'Ostrovok': 'bl-icon-ostrovok',
                    'Aviasales': 'bl-icon-aviasales'
                };
                const svgMap = {
                    'Hotellook': bookingSvgIcons.hotel,
                    'Ostrovok': bookingSvgIcons.hotel,
                    'Aviasales': bookingSvgIcons.search
                };
                for (const link of hotelsData.links) {
                    const iconCls = iconMap[link.service] || 'bl-icon-hotellook';
                    const svgIcon = svgMap[link.service] || bookingSvgIcons.hotel;
                    html += `
                    <a class="booking-link" href="${link.url}" target="_blank" rel="noopener">
                        <div class="bl-icon ${iconCls}">${svgIcon}</div>
                        <div class="bl-info">
                            <div class="bl-name">${link.service}</div>
                            <div class="bl-desc">${link.description} в ${cityName}${datesStr}</div>
                        </div>
                        <div class="bl-arrow">›</div>
                    </a>`;
                }
            }

            if (!html) {
                html = '<div class="booking-empty">Предложения не найдены. Попробуйте позже</div>';
            }

            container.innerHTML = html;
        }

        function parsePlanDays(planText) {
            const sectionKeywords = [
                'ОТЕЛИ', 'ОТЕЛ', 'ГДЕ ОСТАНОВИТЬСЯ', 'РЕСТОРАНЫ', 'ГДЕ ПОЕСТЬ',
                'ДОСТОПРИМЕЧАТЕЛЬНОСТИ', 'ПОЛЕЗНЫЕ СОВЕТЫ', 'ЛАЙФХАКИ',
                'ХОРОШЕГО ПУТЕШЕСТВИЯ'
            ];
            // "БЮДЖЕТ" обрабатываем отдельно с negative lookahead — чтобы НЕ ловить "БЮДЖЕТ НА ДЕНЬ N:"
            // Также добавляем (?!\s*:\s*\d) чтобы не ловить "Бюджет: 50000₽" в заголовке
            const kwPattern = sectionKeywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
                + '|БЮДЖЕТ(?!\\s*:\\s*\\d)(?!\\s+НА\\s+ДЕНЬ)';
            // Матчим: ### 2. Отели, emoji + keyword, **keyword**, ═══ перед keyword
            // ВАЖНО: используем \n\n (без флага m) чтобы ^ матчил только начало строки,
            // а не начало каждой строки — иначе ловим "Бюджет:" в шапке плана
            const sectionRegex = new RegExp(
                '(?:^|\\n\\n)\\s*(?:[═─━\\-=*]{3,}\\s*\\n)?\\s*(?:#{1,4}\\s+)?(?:\\*\\*)?(?:\\d+[\\.)\\-]\\s*)?(?:[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]\\uFE0F?\\s*)?(?:\\d+[\\.)\\-]\\s*)?(' + kwPattern + ')',
                'iu'
            );

            // ── Сначала находим ВСЕ маркеры дней, чтобы определить границу ──
            // Lookbehind: не ловим "БЮДЖЕТ НА ДЕНЬ", "за день" и т.д.
            // Допускаем отсутствие разделителя (День N\n) — Gemini иногда не ставит ":"
            const dayPosRegex = /(?<![НнАа][ \t])(?:#{1,4}[ \t]+)?(?:\*\*)?День[ \t]+\d+(?:[ \t]*\/[ \t]*\d+)?(?:\*\*)?(?:[ \t]*(?:—|–|-|:|\.|\()|[ \t]*\n)/gi;
            let lastDayPos = -1;
            let dpm;
            while ((dpm = dayPosRegex.exec(planText)) !== null) {
                lastDayPos = dpm.index;
            }

            // Найти где начинается общая информация (ОТЕЛИ, ЛАЙФХАКИ и т.д.)
            // Ищем секции ТОЛЬКО после последнего маркера дня — чтобы не ловить
            // ключевые слова ("Бюджет:", "Отели" и т.д.) в шапке плана
            let generalInfoStart = -1;
            if (lastDayPos >= 0) {
                const textAfterLastDay = planText.substring(lastDayPos);
                const matchPos = textAfterLastDay.search(sectionRegex);
                if (matchPos > -1) {
                    generalInfoStart = lastDayPos + matchPos;
                }
            } else {
                generalInfoStart = planText.search(sectionRegex);
            }

            let daysText = planText;
            let generalInfo = '';

            if (generalInfoStart > -1) {
                daysText = planText.substring(0, generalInfoStart).trim();
                generalInfo = planText.substring(generalInfoStart).trim();
            }

            // ── Удаляем вступительный текст до "РАСПИСАНИЕ/МАРШРУТ/ПРОГРАММА ПО ДНЯМ" ──
            // Поддерживаем нумерованный формат: "1. МАРШРУТ ПО ДНЯМ:"
            const scheduleMatch = daysText.match(/(?:^|\n)\s*(?:\d+[.)]\s*)?(?:#{1,4}\s+)?(?:\*\*)?(?:📆\s*)?(?:РАСПИСАНИЕ|МАРШРУТ|ПРОГРАММА(?:\s+ПУТЕШЕСТВИЯ)?)\s+ПО\s+ДНЯМ\s*(?:\*\*)?[:\s]*/im);
            if (scheduleMatch) {
                daysText = daysText.substring(scheduleMatch.index + scheduleMatch[0].length).trim();
            } else {
                // Если нет "РАСПИСАНИЕ", ищем первое вхождение "День \d" и отрезаем всё до него
                // НО: если первый найденный день != 1, не отрезаем — текст до него может быть День 1
                const firstDayMatch = daysText.match(/(?:^|\n)\s*(?:#{1,4}\s+)?(?:\*\*)?День\s+(\d+)/im);
                if (firstDayMatch) {
                    const firstNum = parseInt(firstDayMatch[1]);
                    const firstDayIdx = firstDayMatch.index;
                    if (firstNum === 1 && firstDayIdx > 0) {
                        daysText = daysText.substring(firstDayIdx).trim();
                    } else if (firstNum > 1 && firstDayIdx > 0) {
                        // Текст до "День 2+" — возможно это День 1 без маркера
                        // Не удаляем, оставляем для implicit Day 1 fallback
                        console.log(`[parsePlanDays] First day marker is Day ${firstNum} at pos ${firstDayIdx} — keeping text before it as possible Day 1`);
                    }
                }
            }

            // Главный regex — расширенный: **День N:**, День N -, День N –, День N —, День N.
            // Также: День N\n (без разделителя), День N (Понедельник):, День N/M:
            // Негативный lookbehind: не ловим "БЮДЖЕТ НА ДЕНЬ" / "НА ДЕНЬ" / "за день"
            // ВАЖНО: используем [ \t] вместо \s чтобы НЕ матчить переносы строк
            // (иначе "☀️ ДЕНЬ\n\n2." ловится как "День 2")
            const dayPattern = /(?<![НнАа][ \t])(?:#{1,4}[ \t]+)?(?:\*\*)?День[ \t]+(\d+)(?:[ \t]*\/[ \t]*\d+)?(?:\*\*)?(?:[ \t]*\([^)]*\))?(?:[ \t]*(?:—|–|-|:|\.)|[ \t]*(?=\n))/gi;
            planDays = [];
            let match;

            const dayMatches = [];
            const seenDayNums = new Set();
            while ((match = dayPattern.exec(daysText)) !== null) {
                const num = parseInt(match[1]);
                // Пропускаем дубли — берём только первое вхождение каждого дня
                if (seenDayNums.has(num)) continue;
                seenDayNums.add(num);
                dayMatches.push({
                    num: num,
                    startPos: match.index,
                    endPos: match.index + match[0].length
                });
            }
            console.log(`[parsePlanDays] dayPattern found ${dayMatches.length} days: [${dayMatches.map(d=>'Day'+d.num).join(',')}], lastDayPos=${lastDayPos}, generalInfoStart=${generalInfoStart}`);

            // ── Если День 1 отсутствует, но перед первым найденным днём есть контент — это День 1 ──
            if (dayMatches.length > 0 && dayMatches[0].num > 1 && dayMatches[0].startPos > 30) {
                const implicitDay1Content = daysText.substring(0, dayMatches[0].startPos).trim();
                // Проверяем что это реальный контент (есть номера мест или временные блоки)
                if (implicitDay1Content.length > 30 && /(?:\d+\.\s|🌅|☀|🌙)/u.test(implicitDay1Content)) {
                    console.log(`[parsePlanDays] Day 1 marker missing! Implicit Day 1 found: ${implicitDay1Content.length} chars before Day ${dayMatches[0].num}`);
                    dayMatches.unshift({
                        num: 1,
                        startPos: 0,
                        endPos: 0  // content starts from position 0
                    });
                }
            }

            // Разбиваем текст по найденным дням
            for (let i = 0; i < dayMatches.length; i++) {
                const dayMatch = dayMatches[i];
                const contentStart = dayMatch.endPos;
                const contentEnd = (i + 1 < dayMatches.length) ? dayMatches[i + 1].startPos : daysText.length;
                
                let content = daysText.substring(contentStart, contentEnd).trim();
                
                // Убрать разделители
                content = content.replace(/^[─=\-━]{5,}/m, '').trim();
                
                // Вырезаем встроенную бюджетную секцию "💰 БЮДЖЕТ НА ДЕНЬ N:" из контента дня
                const budgetInDayIdx = content.search(/(?:^|\n)\s*💰\s*БЮДЖЕТ\s+НА\s+ДЕНЬ/im);
                if (budgetInDayIdx > 0) {
                    const budgetSection = content.substring(budgetInDayIdx).trim();
                    generalInfo = budgetSection + (generalInfo ? '\n\n' + generalInfo : '');
                    content = content.substring(0, budgetInDayIdx).trim();
                }

                // Дополнительно: если в контенте дня затесалась секция общей информации
                const innerSectionIdx = content.search(sectionRegex);
                if (innerSectionIdx > 0) {
                    const extra = content.substring(innerSectionIdx).trim();
                    generalInfo = extra + (generalInfo ? '\n\n' + generalInfo : '');
                    content = content.substring(0, innerSectionIdx).trim();
                }
                
                if (content) {
                    planDays.push({
                        dayNum: dayMatch.num,
                        content: stripDayHeadersFromContent(content)
                    });
                } else {
                    console.warn(`[parsePlanDays] Day ${dayMatch.num} has EMPTY content after cleanup!`);
                }
            }

            console.log(`[parsePlanDays] Result: ${planDays.length} days: [${planDays.map(d=>'Day'+d.dayNum+'('+d.content.length+'ch)').join(', ')}]`);            // Fallback: разбить по пустым строкам, но пропустить заголовки/вступления
            // Ограничиваем макс. количество дней — tripData.daysCount или 14
            if (planDays.length === 0 && daysText.trim()) {
                const maxDays = (tripData && tripData.daysCount) ? tripData.daysCount : 14;
                console.warn(`[parsePlanDays] FALLBACK: dayPattern found 0 days! Splitting ${daysText.length} chars by paragraphs, maxDays=${maxDays}`);
                console.warn(`[parsePlanDays] First 300 chars of daysText:`, daysText.substring(0, 300));
                const paragraphs = daysText.split(/\n\n+/).filter(p => p.trim());
                let dayNum = 1;
                paragraphs.forEach(p => {
                    if (dayNum > maxDays) return;
                    const t = p.trim();
                    // Пропускаем короткие заголовки, "РАСПИСАНИЕ", вступления без конкретики
                    if (t.length < 30 && !/\d{1,2}[:.]\d{2}/.test(t)) return;
                    if (/^(?:#{1,4}\s+)?(?:\*\*)?(?:📆\s*)?РАСПИСАНИЕ/i.test(t)) return;
                    if (/^(?:#{1,4}\s+)?(?:\*\*)?(?:📅|📆|🌟|🗼|✈️)/.test(t) && t.length < 200 && !/\d{1,2}[:.]\d{2}/.test(t)) return;
                    planDays.push({ dayNum: dayNum++, content: t });
                });
            }

            const tripInfoDiv = document.getElementById('tripInfo');
            if (tripInfoDiv) {
                tripInfoDiv.innerHTML = '';
                if (generalInfo) {
                    const cleanText = generalInfo
                        .replace(/\*\*/g, '')
                        .replace(/^#{1,4}\s*/gm, '')
                        .trim();
                    tripInfoDiv.innerHTML = `<pre style="white-space:pre-wrap;font-family:inherit;margin:0;color:#4A4446;font-size:13px;line-height:1.7;">${cleanText}</pre>`;
                }
            }

            renderDayButtons();

            if (planDays.length > 0) {
                loadAllDaysOnMap();
            }
        }

        function extractPlacesFromDay(text, dayObj) {
            if (dayObj && Array.isArray(dayObj.jsonPlaces) && dayObj.jsonPlaces.length) {
                return dayObj.jsonPlaces.map((p) => {
                    const name = String(p.name || '').trim();
                    return p.address ? `${name} (${p.address})` : name;
                }).filter(Boolean);
            }
            // ─── Нормализация: склеиваем разбитые маркеры УТРО/ДЕНЬ/ВЕЧЕР ───
            // Gemini иногда разбивает "☀️ ДЕНЬ" на две строки: "☀️ \n ДЕНЬ"
            let normalized = (text || '')
                .replace(/([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\uFE0E\uFE0F]?)\s*\n\s*(УТРО|ДЕНЬ|ВЕЧЕР)/giu, '$1 $2')
                // Также склеиваем "☀️\nДЕНЬ" без пробела
                .replace(/([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\uFE0E\uFE0F]?)\n(УТРО|ДЕНЬ|ВЕЧЕР)/giu, '$1 $2');

            console.log('[extractPlaces] Input text (first 500 chars):', normalized.substring(0, 500));
            const allLines = normalized.split('\n');
            const places = [];
            const seen = new Set();

            // Утилита: удалить эмодзи из строки
            function stripEmoji(s) {
                return s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{FE0E}]/gu, '').trim();
            }

            // ─── Шаг 0: Берём ТОЛЬКО строки расписания (до секций ОТЕЛИ/РЕСТОРАНЫ/БЮДЖЕТ) ───
            const scheduleLines = [];
            // Ловим секции общей информации
            const sectionStop = /^(?:#{1,4}\s*)?(?:\d+[.\)]\s*)?(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?\s*)?(?:ОТЕЛИ|РЕСТОРАНЫ|ДОСТОПРИМЕЧАТЕЛЬНОСТИ|ЛАЙФХАК|TIPS|ГДЕ ОСТАНОВИТЬСЯ|ГДЕ ПОЕСТЬ|ПОЛЕЗНЫЕ СОВЕТЫ)/iu;
            const budgetLine = /^[💰💳]\s*(?:БЮДЖЕТ|ИТОГО|РАСХОД|TOTAL|ВСЕГО|НА ДЕНЬ)/iu;

            // Regex для маркеров УТРО/ДЕНЬ/ВЕЧЕР во всех форматах:
            // "🌅 УТРО", "☀️ ДЕНЬ", "🌙 ВЕЧЕР", просто "УТРО", "ДЕНЬ", "ВЕЧЕР"
            // Также голый эмодзи "☀️" на отдельной строке (остаток от разбитого маркера)
            const timeBlockMarker = /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\uFE0E\uFE0F]?\s*(УТРО|ДЕНЬ|ВЕЧЕР)\s*$/iu;
            const bareLine = /^(УТРО|ДЕНЬ|ВЕЧЕР|НОЧЬ)\s*$/i;
            const bareEmoji = /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\uFE0E\uFE0F]?\s*$/u;

            let isFirstContentLine = true;
            for (const line of allLines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                if (sectionStop.test(trimmed)) break;
                // ─── Сначала пропускаем маркеры времени суток (до budgetLine!) ───
                if (timeBlockMarker.test(trimmed)) continue;
                if (bareLine.test(trimmed)) continue;
                if (bareEmoji.test(trimmed)) continue;
                if (/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\uFE0E\uFE0F]?\s*(УТРО|ДЕНЬ|ВЕЧЕР)/iu.test(trimmed)) continue;
                if (/^(УТРО|ДЕНЬ|ВЕЧЕР)\b/i.test(trimmed)) continue;
                // ─── Теперь проверяем бюджетные строки (после фильтрации emoji-маркеров) ───
                if (budgetLine.test(trimmed)) break;
                // Пропускаем строки-подсказки (примерное/приблизительное время в пути)
                if (/^\*?\s*(примерное|приблизительное)\s+время/i.test(trimmed)) continue;
                // Пропускаем строки "От предыдущего места: X мин пешком"
                if (/^от\s+(предыдущего|прошлого)\s+(места|точки)/i.test(trimmed)) continue;
                // Пропускаем заголовки "День N" внутри контента
                if (/^День\s+\d+/i.test(trimmed) && !/^\d+\./.test(trimmed)) continue;
                // Пропускаем подзаголовок дня (первая строка контента) —
                // "КЛАССИКА, ВЫСОКАЯ КУХНЯ И ШОПИНГ В ЦЕНТРЕ", "ИКОНИЧЕСКИЕ ВИДЫ И РОМАНТИКА"
                // Признак: первая непустая строка, НЕ начинается с цифры, НЕ содержит (адрес)
                if (isFirstContentLine) {
                    isFirstContentLine = false;
                    if (!/^\d+[.\)]\s/.test(trimmed) && !/\([^)]*(?:\d|via|rue|street|avenue|piazza|place)/i.test(trimmed)) {
                        continue;
                    }
                }
                scheduleLines.push(trimmed);
            }
            console.log('[extractPlaces] scheduleLines count:', scheduleLines.length);

            // Стоп-слова
            const skipWords = new Set([
                'завтрак', 'обед', 'ужин', 'транспорт', 'бюджет', 'итого',
                'достопримечательность', 'перекус', 'отели', 'рестораны',
                'лайфхаки', 'день', 'маршрут', 'совет', 'автобус', 'метро',
                'такси', 'трамвай', 'пешком',
                'утро', 'вечер', 'ночь'
            ]);

            function isValidPlace(name) {
                if (!name || name.length < 3 || name.length > 90) return false;
                if (skipWords.has(name.toLowerCase())) return false;
                if (/^(мы|по нашему|проверено|средний|стоимость|цена|вход|бесплатно|примерно|транспорт|метро до)/i.test(name)) return false;
                if (/^(один|это|здесь|после|начните|посетите|обязательно|прогуляйтесь|завершите|приветствуем|составь|используй)/i.test(name)) return false;
                if (/^от\s+(предыдущего|прошлого)\s+(места|точки)/i.test(name)) return false;
                if (/^\d+\s*(мин|минут)\s*(пешком|на\s)/i.test(name)) return false;
                if (/^\d+\s*(₽|€|\$|₺)/.test(name)) return false;
                if (/^(УТРО|ДЕНЬ|ВЕЧЕР|НОЧЬ)\b/i.test(name)) return false;
                if (/^День\s+\d+/i.test(name)) return false;
                if (/^Цена:/i.test(name)) return false;
                // Слишком много слов — скорее описание, не название места
                // Считаем только до скобок (адрес может быть длинным)
                const nameBeforeParens = name.split(/\s*\(/)[0];
                if (nameBeforeParens.split(/\s+/).length > 8) return false;
                return true;
            }

            function addPlace(name) {
                let clean = cleanPlaceName(name);
                if (isValidPlace(clean) && !seen.has(clean.toLowerCase())) {
                    seen.add(clean.toLowerCase());
                    places.push(clean);
                }
            }

            for (const line of scheduleLines) {
                // Убираем лидирующие эмодзи для более надёжного парсинга
                const lineStripped = line.replace(/^(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\uFE0E\uFE0F]?\s*)+/gu, '');
                // ─── Стратегия 0: Нумерованный список "1. ENGLISH NAME (Русское) — адрес" ───
                const numberedMatch = lineStripped.match(/^(\d+)[.\)]\s+([A-Za-zА-ЯЁа-яё«"][^\n]{2,})/);
                if (numberedMatch) {
                    let candidate = numberedMatch[2].trim();
                    // Убираем адрес/описание после тире: "COLOSSEUM (Колизей) — Via dei..." → "COLOSSEUM (Колизей)"
                    candidate = candidate.split(/\s*[—–]\s/)[0].trim();
                    candidate = candidate.split(/\.\s+(?=[А-ЯЁA-Z])/)[0].trim();
                    candidate = candidate.replace(/\.$/, '').trim();
                    addPlace(candidate);
                    continue;
                }

                // ─── Стратегия 0.5: НАЗВАНИЕ (адрес) без нумерации ───
                // e.g. "ЛУВР (Rue de Rivoli, 75001 Paris)", "КОЛИЗЕЙ, РИМСКИЙ ФОРУМ (Via dei Fori)"
                const capsAddrMatch = lineStripped.match(/^([A-ZА-ЯЁ][A-ZА-ЯЁa-zа-яёA-Za-z\s,\-''·&]+?)\s*\(([^)]+)\)/);
                if (capsAddrMatch) {
                    const capName = capsAddrMatch[1].trim();
                    const paren = capsAddrMatch[2];
                    const looksLikeAddr = /\d/.test(paren) || /,/.test(paren) ||
                        /via|rue|street|avenue|boulevard|piazza|plaza|place|calle|carrer|strasse|road|platz|passage|район/i.test(paren);
                    if (looksLikeAddr && capName.length >= 3 && isValidPlace(capName)) {
                        addPlace(capName + ' (' + paren + ')');
                        continue;
                    }
                }

                // ─── Стратегия 0.55: Маркированный список "- МЕСТО" или "• МЕСТО" ───
                const dashMatch = lineStripped.match(/^[-•–]\s+([A-Za-zА-ЯЁа-яё«"][^\n]{2,})/);
                if (dashMatch) {
                    let candidate = dashMatch[1].trim();
                    candidate = candidate.split(/\s*[—–]\s/)[0].trim();
                    candidate = candidate.split(/\.\s+(?=[А-ЯЁA-Z])/)[0].trim();
                    candidate = candidate.replace(/\.$/, '').trim();
                    if (isValidPlace(candidate)) {
                        addPlace(candidate);
                        continue;
                    }
                }

                // ─── Стратегия 0.6: **Жирное название** в любой строке ───
                if (/\*\*/.test(line)) {
                    const boldAnyLine = [...line.matchAll(/\*\*([^*]{3,})\*\*/g)];
                    let foundBoldAny = false;
                    for (const bm of boldAnyLine) {
                        let candidate = bm[1].trim();
                        if (/^\d{1,2}[:.]\d{2}/.test(candidate)) continue;
                        if (/^(ЗАВТРАК|ОБЕД|УЖИН|ТРАНСПОРТ|БЮДЖЕТ|ИТОГО|МАРШРУТ|РАСПИСАНИЕ)/i.test(candidate)) continue;
                        const afterBold = line.substring(line.indexOf(bm[0]) + bm[0].length);
                        const parenAddr = afterBold.match(/^\s*\(([^)]+)\)/);
                        if (parenAddr) {
                            addPlace(candidate + ' (' + parenAddr[1] + ')');
                        } else {
                            candidate = candidate.split(/\.\s+(?=[А-ЯЁA-Z])/)[0].trim();
                            candidate = candidate.split(/\s*[—–]\s/)[0].trim();
                            candidate = candidate.replace(/\.$/, '').trim();
                            addPlace(candidate);
                        }
                        foundBoldAny = true;
                    }
                    if (foundBoldAny) continue;
                }

                // Проверяем что это строка расписания (начинается с - или содержит время)
                const isScheduleLine = /^[-•]\s*\d{1,2}[:.]\d{2}/.test(lineStripped) || /^\d{1,2}[:.]\d{2}\s*[-–—]/.test(lineStripped);
                if (!isScheduleLine) continue;

                // Убираем эмодзи из строки для парсинга
                const cleanLine = stripEmoji(line);

                // Пропускаем транспортные строки (нет конкретного места-достопримечательности)
                if (/транспорт\s+до/i.test(cleanLine) || /метро\s+до/i.test(cleanLine)) continue;
                if (/\d{1,2}[:.]\.\d{2}\s*[-–—]\s*ТРАНСПОРТ\s*[:—–-]/i.test(cleanLine)) continue;

                // ─── Стратегия A: **Жирное Название** внутри строки ───
                let foundBold = false;
                const boldMatches = [...cleanLine.matchAll(/\*\*([^*]+)\*\*/g)];
                for (const m of boldMatches) {
                    let candidate = m[1].trim();
                    if (/^\d{1,2}[:.]\d{2}/.test(candidate)) continue;
                    if (/^(ЗАВТРАК|ОБЕД|УЖИН|ТРАНСПОРТ|ДОСТОПРИМЕЧАТЕЛЬНОСТЬ)/i.test(candidate)) continue;
                    if (/\d{1,2}[:.]\d{2}\s*[-–—]\s*(ЗАВТРАК|ОБЕД|УЖИН|ТРАНСПОРТ|ДОСТОПРИМЕЧАТЕЛЬНОСТЬ)/i.test(candidate)) continue;
                    addPlace(candidate);
                    foundBold = true;
                }
                if (foundBold) continue;

                // ─── Стратегия B: "09:00 - [emoji] КАТЕГОРИЯ: Название — описание" ───
                const catMatch = cleanLine.match(/\d{1,2}[:.]\d{2}\s*[-–—]\s*(?:ЗАВТРАК|ОБЕД|УЖИН|ДОСТОПРИМЕЧАТЕЛЬНОСТЬ|ПРОГУЛКА|ШОПИНГ|РАЗВЛЕЧЕНИЯ)\s*[:：]\s*(.+)/i);
                if (catMatch) {
                    let candidate = catMatch[1].trim();
                    // Обрезаем по точке + пробел + заглавная ("Пантеон. Это невероятное..." → "Пантеон")
                    candidate = candidate.split(/\.\s+(?=[А-ЯЁA-Z])/)[0].trim();
                    candidate = candidate.split(/\s*[—–]\s/)[0].trim();
                    candidate = candidate.split(/\s*[-–—,]\s*(?:средн|стоимость|цена|вход|чек|~)/i)[0].trim();
                    candidate = candidate.split(/\s*\(\s*~/)[0].trim();
                    // Убираем завершающую точку если осталась
                    candidate = candidate.replace(/\.$/, '').trim();
                    addPlace(candidate);
                    continue;
                }

                // ─── Стратегия C: "09:00 - Название Места — описание" (без категории) ───
                const noCatMatch = cleanLine.match(/\d{1,2}[:.]\d{2}\s*[-–—]\s*(.+)/);
                if (noCatMatch) {
                    let rest = noCatMatch[1].trim();
                    // Убираем категорию если она в начале (ЗАВТРАК: / ОБЕД: / ...)
                    rest = rest.replace(/^(?:ЗАВТРАК|ОБЕД|УЖИН|ТРАНСПОРТ|ДОСТОПРИМЕЧАТЕЛЬНОСТЬ)\s*[-–—:]\s*/i, '');
                    // Если осталось "Транспорт до...", пропускаем
                    if (/^транспорт|^метро\s+до|^автобус\s+(?:до|от)|^такси\s+до|^вечерняя\s+прогулка|^прогулка/i.test(rest)) continue;
                    // Обрезаем по точке + пробел + заглавная ("Название. Описание..." → "Название")
                    let candidate = rest.split(/\.\s+(?=[А-ЯЁA-Z])/)[0].trim();
                    candidate = candidate.split(/\s*[—–]\s/)[0].trim();
                    candidate = candidate.split(/\s*~\s*/)[0].trim();
                    candidate = candidate.split(/\s*\(\s*/)[0].trim();
                    candidate = candidate.replace(/\s*[-–—,]\s*(средний|стоимость|цена|вход|чек|бесплатно).*/i, '').trim();
                    // Убираем завершающую точку если осталась
                    candidate = candidate.replace(/\.$/, '').trim();
                    addPlace(candidate);
                }
            }

            // ─── Фолбэк: если ничего не нашли, ищем строки ЗАГЛАВНЫМИ БУКВАМИ ───
            if (places.length === 0) {
                console.log('[extractPlaces] FALLBACK: trying ALL-CAPS lines from', scheduleLines.length, 'lines');
                for (let i = 0; i < scheduleLines.length; i++) {
                    const line = scheduleLines[i];
                    // Строка в ЗАГЛАВНЫХ БУКВАХ (минимум 3 символа кириллицы/латиницы заглавными)
                    // Пропускаем стоп-строки: УТРО, ДЕНЬ, ВЕЧЕР, БЮДЖЕТ, ИТОГО, ОТЕЛИ, МАРШРУТ
                    const capsCore = line.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '').trim();
                    if (/^(УТРО|ДЕНЬ|ВЕЧЕР|НОЧЬ|БЮДЖЕТ|ИТОГО|ОТЕЛИ|РЕСТОРАНЫ|МАРШРУТ|РАСПИСАНИЕ|ЛАЙФХАКИ|ПОЛЕЗНЫЕ)/i.test(capsCore)) {
                        continue;
                    }
                    // Пропускаем подзаголовки дней — длинные фразы без адресов: "ИКОНИЧЕСКИЕ ВИДЫ И ФРАНЦУЗСКАЯ КЛАССИКА"
                    if (capsCore.split(/\s+/).length > 4 && !/\(/.test(capsCore)) continue;
                    // Ищем строку, где большинство букв заглавные (>60%) и есть хотя бы 3 заглавные буквы
                    const letters = capsCore.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
                    const upperLetters = capsCore.replace(/[^A-ZА-ЯЁ]/g, '');
                    if (letters.length >= 3 && upperLetters.length >= 3 && upperLetters.length / letters.length > 0.6) {
                        // Проверяем, есть ли на следующей строке адрес в скобках
                        let placeName = capsCore;
                        if (i + 1 < scheduleLines.length) {
                            const nextLine = scheduleLines[i + 1];
                            const addrMatch = nextLine.match(/^\s*\(([^)]+)\)/);
                            const nextAddr = nextLine.match(/^(?:Адрес|Address|Rue|Via|Piazza|Avenue|Boulevard|Place|Calle|Carrer|Street|Road)\b/i);
                            if (addrMatch) {
                                placeName = capsCore + ' ' + addrMatch[0];
                            } else if (nextAddr) {
                                placeName = capsCore + ' (' + nextLine.trim() + ')';
                            }
                        }
                        addPlace(placeName);
                    }
                }
                console.log('[extractPlaces] FALLBACK result:', places.length, 'places');
            }

            // ─── Финальный фолбэк: ищем паттерн "Название (адрес)" по ВСЕМ строкам ───
            if (places.length === 0) {
                console.log('[extractPlaces] ULTIMATE FALLBACK: searching ALL lines for Name (address)');
                for (const line of allLines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    if (/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\uFE0E\uFE0F]?\s*(УТРО|ДЕНЬ|ВЕЧЕР)/iu.test(trimmed)) continue;
                    if (/^(УТРО|ДЕНЬ|ВЕЧЕР|НОЧЬ)\s*$/i.test(trimmed)) continue;
                    // Убираем ведущие номера, маркеры, эмодзи
                    const clean = trimmed.replace(/^(?:\d+[.\)]\s*|[-•–]\s*|(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\uFE0E\uFE0F]?\s*)+)/gu, '');
                    // Ищем паттерн Название (адрес)
                    const nameAddr = clean.match(/^([A-Za-zА-ЯЁа-яё][A-Za-zА-ЯЁа-яёA-Za-z\s,\-''·&]{2,}?)\s*\(([^)]+)\)/);
                    if (nameAddr) {
                        const name = nameAddr[1].trim();
                        const paren = nameAddr[2];
                        const looksLikeAddr = /\d/.test(paren) || /,/.test(paren) ||
                            /via|rue|street|avenue|boulevard|piazza|plaza|place|calle|carrer|strasse|road|район|проспект|улица/i.test(paren);
                        if (looksLikeAddr && name.length >= 3 && isValidPlace(name)) {
                            addPlace(name + ' (' + paren + ')');
                        }
                    }
                }
                console.log('[extractPlaces] ULTIMATE FALLBACK result:', places.length, 'places');
            }

            console.log('[extractPlaces] Result:', places.length, 'places:', places);
            return places.slice(0, 10);
        }

        function cleanPlaceName(name) {
            let s = name;
            // Remove markdown bold/italic
            s = s.replace(/\*{1,3}/g, '');
            // Remove emojis
            s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
            // Remove leading/trailing # markdown headers
            s = s.replace(/^#{1,4}\s*/, '');
            // Cut at description after " - " or " — " or " – " (keep only the place name)
            s = s.replace(/\s+[-–—]\s+.*$/, '');
            // Remove bracketed content like [Третьяковская] → Третьяковская
            s = s.replace(/^\[|\]$/g, '');
            // Remove trailing category words like "музей", "ресторан" only if preceded by dash
            // Remove leading numbers like "1." or "2)"
            s = s.replace(/^\d+[\.)\-]\s*/, '');
            // Trim
            s = s.trim();
            // Remove trailing punctuation
            s = s.replace(/[,:;.!]+$/, '').trim();
            return s;
        }

        // Extract only the core place name (no address, street, house number)
        // e.g. "Колизей, Via dei Fori Imperiali, 1" → "Колизей"
        // e.g. "Рынок Цукидзи (Tsukiji Outer Market)" → "Рынок Цукидзи"
        function extractCoreName(name) {
            let s = name;
            // Remove content in parentheses (transliterations, alt names)
            s = s.replace(/\s*\([^)]*\)/g, '');
            // Split by comma — typically first part is the name, rest is address
            const parts = s.split(/\s*,\s*/);
            // Take first part only (the actual name)
            s = parts[0];
            // Remove trailing house/building numbers like "д. 5" or just trailing digits
            s = s.replace(/\s+(?:д\.?|дом|ул\.?|улица|str\.?|via|avenue|ave|st|blvd|road|rd|plaza|platz|piazza)\b.*$/i, '');
            s = s.replace(/\s+\d+[\s/]*\d*\s*$/, '');
            // Trim
            s = s.trim().replace(/[,:;.!]+$/, '').trim();
            return s || name; // fallback to original if empty
        }

        function formatDayContent(text) {
            // Убираем служебные строки «День N» — заголовок дня показывает шапка листа
            text = stripDayHeadersFromContent(text);
            // Escape HTML
            let escaped = text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            // Split into lines and process
            const lines = escaped.split('\n');
            let html = '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (/^🌅\s*УТРО/i.test(trimmed)) {
                    html += '<div class="time-block-header morning">' + trimmed + '</div>';
                } else if (/^☀[\uFE0F️]?\s*ДЕНЬ/i.test(trimmed) || /^🌆\s*ДЕНЬ/i.test(trimmed)) {
                    html += '<div class="time-block-header afternoon">' + trimmed + '</div>';
                } else if (/^🌙\s*ВЕЧЕР/i.test(trimmed) || /^🌃\s*ВЕЧЕР/i.test(trimmed)) {
                    html += '<div class="time-block-header evening">' + trimmed + '</div>';
                } else {
                    html += line + '\n';
                }
            }
            return html;
        }

        function selectDay(dayIndex) {
            const day = planDays[dayIndex];
            if (!day) return;
            if (day.locked) {
                openPaywall();
                return;
            }


            currentDayIndex = dayIndex;

            // Auto-expand from PEEK to MID when a day is selected
            if (window._sheet && window._sheet.current === window._sheet.SNAP.PEEK) {
                window._sheet.snapTo(window._sheet.SNAP.MID);
            }

            document.querySelectorAll('.day-btn').forEach((btn, idx) => {
                btn.classList.toggle('active', idx === dayIndex);
            });

            // Highlight active weather card и подкручиваем полосу к нему
            document.querySelectorAll('.weather-day').forEach((el, idx) => {
                const on = idx === dayIndex;
                el.classList.toggle('active', on);
                if (on) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            });

            // Highlight active legend item
            document.querySelectorAll('.map-legend-item').forEach((el, idx) => {
                el.classList.toggle('active', idx === dayIndex);
            });

            document.getElementById('mapSection').classList.remove('hidden');
            document.getElementById('routeSummary').style.display = 'none';
            document.getElementById('placeCards').innerHTML = '';

            let displayText = day.content;
            const dayTextEl = document.getElementById('dayText');
            if (dayTextEl) {
                dayTextEl.style.display = 'none';
            }
            try { leafletMap && leafletMap.invalidateSize(); } catch (e) {}

            // Прокручиваем маршрут к началу выбранного дня
            const sheetScrollEl = document.getElementById('sheetScroll');
            if (sheetScrollEl) sheetScrollEl.scrollTo({ top: 0, behavior: 'smooth' });

            // If cached multi-day data exists → use it (fast path)
            if (allDaysPlaceInfo[dayIndex]) {
                highlightDayOnMap(dayIndex);
                currentPlaceInfo = allDaysPlaceInfo[dayIndex];
                currentRouteData = allDaysRouteData[dayIndex] || null;
                showPlacesInfo(currentPlaceInfo, dayIndex, currentRouteData);
                loadPlacePhotos(currentPlaceInfo, dayIndex);
                return;
            }

            // Fallback: legacy single-day geocoding
            const candidatePlaces = extractPlacesFromDay(displayText, day);
            extractAndShowMap(displayText, day.dayNum, dayIndex, candidatePlaces);
        }

        // === TSP: Nearest-Neighbor эвристика для оптимизации маршрута ===
        // Строит кратчайший путь обхода всех точек (задача коммивояжёра)
        // Начинает с первой точки, каждый раз идёт к ближайшей непосещённой
        // Затем 2-opt улучшение: пытается убрать пересечения маршрута
        function tspNearestNeighbor(places) {
            if (places.length <= 2) return [...places];

            // Haversine distance in meters
            function haversine(a, b) {
                const R = 6371000;
                const toRad = d => d * Math.PI / 180;
                const dLat = toRad(b.lat - a.lat);
                const dLon = toRad(b.lon - a.lon);
                const sa = Math.sin(dLat / 2);
                const sb = Math.sin(dLon / 2);
                const h = sa * sa + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sb * sb;
                return 2 * R * Math.asin(Math.sqrt(h));
            }

            // Nearest-Neighbor: начинаем с первой точки
            const n = places.length;
            const visited = new Array(n).fill(false);
            const route = [0]; // начинаем с первого места
            visited[0] = true;

            for (let step = 1; step < n; step++) {
                const last = route[route.length - 1];
                let bestDist = Infinity;
                let bestIdx = -1;
                for (let i = 0; i < n; i++) {
                    if (visited[i]) continue;
                    const d = haversine(places[last], places[i]);
                    if (d < bestDist) {
                        bestDist = d;
                        bestIdx = i;
                    }
                }
                if (bestIdx >= 0) {
                    visited[bestIdx] = true;
                    route.push(bestIdx);
                }
            }

            // 2-opt улучшение: убираем пересечения
            function totalDist(r) {
                let sum = 0;
                for (let i = 0; i < r.length - 1; i++) {
                    sum += haversine(places[r[i]], places[r[i + 1]]);
                }
                return sum;
            }

            let improved = true;
            let maxIter = 100;
            while (improved && maxIter-- > 0) {
                improved = false;
                for (let i = 1; i < route.length - 1; i++) {
                    for (let j = i + 1; j < route.length; j++) {
                        // Reverse segment [i..j]
                        const newRoute = [...route];
                        let left = i, right = j;
                        while (left < right) {
                            [newRoute[left], newRoute[right]] = [newRoute[right], newRoute[left]];
                            left++;
                            right--;
                        }
                        if (totalDist(newRoute) < totalDist(route)) {
                            route.splice(0, route.length, ...newRoute);
                            improved = true;
                        }
                    }
                }
            }

            return route.map(i => places[i]);
        }

        // ═══════════════════════════════════════════════════
        // ═══ MULTI-DAY MAP: Load all days at once ═══════
        // ═══════════════════════════════════════════════════
        async function loadAllDaysOnMap() {
            const mapEl = document.getElementById('leafletMap');
            const mapSection = document.getElementById('mapSection');
            const loadingOverlay = document.getElementById('mapLoadingOverlay');
            const loadingText = loadingOverlay?.querySelector('.map-loading-text');
            const loadingProgress = loadingOverlay?.querySelector('.map-loading-progress');

            mapSection.classList.remove('hidden');
            if (loadingOverlay) loadingOverlay.classList.remove('hidden');

            // Initialize map
            if (typeof L === 'undefined' || !mapEl) {
                if (loadingOverlay) loadingOverlay.classList.add('hidden');
                return;
            }

            if (!leafletMap) {
                try {
                    const initCoord = destCoords ? [destCoords.lat, destCoords.lon] : [48.8566, 2.3522];
                    leafletMap = L.map(mapEl).setView(initCoord, 13);
                    addMapTileLayer(leafletMap);
                } catch (e) { leafletMap = null; if (loadingOverlay) loadingOverlay.classList.add('hidden'); return; }
            } else {
                leafletMap.eachLayer(layer => {
                    if (layer instanceof L.Marker || layer instanceof L.Polyline) leafletMap.removeLayer(layer);
                });
            }

            // POI overlay (option A + B): clicks + nearby POIs
            try { initPoiOverlay(); } catch (e) {}

            // Clear old layer groups
            Object.values(allDaysMapLayers).forEach(lg => { try { leafletMap.removeLayer(lg); } catch(e){} });
            allDaysPlaceInfo = {};
            allDaysRouteData = {};
            allDaysMapLayers = {};
            window._dayRouteSegments = window._dayRouteSegments || {};

            const allBounds = [];

            // Process each day sequentially (to not overload server)
            for (let dayIndex = 0; dayIndex < planDays.length; dayIndex++) {
                const day = planDays[dayIndex];
                const color = dayColors[dayIndex % dayColors.length];

                if (!day || day.locked || !String(day.content || '').trim()) continue;

                if (loadingText) loadingText.textContent = `Загружаем маршруты...`;
                if (loadingProgress) loadingProgress.textContent = `День ${dayIndex + 1} из ${planDays.length}`;

                let rawPlaces = [];
                let fromServer = false;
                const jsonPts = Array.isArray(day.jsonPlaces) ? day.jsonPlaces : [];
                const withCoords = jsonPts.filter((p) =>
                    p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)) && String(p.name || '').trim()
                );
                if (withCoords.length >= 1) {
                    fromServer = true;
                    rawPlaces = withCoords.map((p) => ({
                        name: String(p.name).trim(),
                        lat: Number(p.lat),
                        lon: Number(p.lon),
                    }));
                } else {
                    const candidatePlaces = extractPlacesFromDay(day.content, day);
                    if (candidatePlaces.length === 0) continue;

                    const geocodeResults = await Promise.all(
                        candidatePlaces.filter(p => p.trim()).map(async (place) => {
                            const trimmed = place.trim();
                            try {
                                const geoBody = {place: trimmed, destination: tripData.destination || ''};
                                if (destCoords) { geoBody.destLat = destCoords.lat; geoBody.destLon = destCoords.lon; }
                                const controller = new AbortController();
                                const tid = setTimeout(() => controller.abort(), 10000);
                                const resp = await fetch('/api/geocode', {
                                    method: 'POST',
                                    headers: {'Content-Type': 'application/json'},
                                    body: JSON.stringify(geoBody),
                                    signal: controller.signal
                                });
                                clearTimeout(tid);
                                if (!resp.ok) return null;
                                const data = await resp.json();
                                if (data.success && data.lat && data.lon) return { name: trimmed, lat: data.lat, lon: data.lon };
                            } catch (e) {}
                            return null;
                        })
                    );
                    rawPlaces = geocodeResults.filter(r => r);
                }
                if (rawPlaces.length === 0) continue;

                // Keep server walking order when coords already came from OSM catalog.
                let optimized = rawPlaces;
                if (!fromServer) {
                    try {
                        const optResp = await fetch('/api/optimize-day', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({places: rawPlaces})
                        });
                        const optData = await optResp.json();
                        if (optData.success && optData.places?.length > 0) {
                            optimized = optData.places;
                            if (optData.segments) window._dayRouteSegments[dayIndex] = optData.segments;
                        }
                    } catch (e) { optimized = tspNearestNeighbor(rawPlaces); }
                }

                const placeInfo = optimized.map((p, i) => ({ num: i + 1, name: p.name, lat: p.lat, lon: p.lon }));
                allDaysPlaceInfo[dayIndex] = placeInfo;

                // Create layer group for this day
                const layerGroup = L.layerGroup();

                // Markers with day color
                placeInfo.forEach(place => {
                    const icon = L.divIcon({
                        html: `<div class="nm-pin" style="background:${color};animation-delay:${(place.num-1)*0.06}s"><span>${place.num}</span></div>`,
                        iconSize: [36, 36], iconAnchor: [18, 36],
                        className: 'numbered-marker'
                    });
                    const marker = L.marker([place.lat, place.lon], {icon})
                        .bindPopup(`<b>День ${day.dayNum}: ${place.num}. ${place.name}</b>`);
                    marker.on('click', () => {
                        selectDay(dayIndex);
                        setTimeout(() => focusPlaceOnMap(dayIndex, place.num - 1), 40);
                    });
                    window._tbMarkers[dayIndex + '-' + (place.num - 1)] = marker;
                    layerGroup.addLayer(marker);
                    allBounds.push([place.lat, place.lon]);
                });

                // OSRM walking route
                if (placeInfo.length >= 2) {
                    let drawn = false;
                    try {
                        const routePoints = placeInfo.map(p => ({lat: p.lat, lon: p.lon}));
                        const resp = await fetch('/api/route', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({points: routePoints, profile: 'foot'})
                        });
                        if (resp.ok) {
                            const rd = await resp.json();
                            if (rd.success && rd.geometry?.coordinates) {
                                rd.distance_km = Math.round(rd.distance / 100) / 10;
                                rd.duration_min = Math.max(1, Math.round(rd.duration / 60));
                                allDaysRouteData[dayIndex] = rd;
                                const routeCoords = rd.geometry.coordinates.map(c => [c[1], c[0]]);
                                const polyline = L.polyline(routeCoords, {
                                    color: color, weight: 5, opacity: 0.8,
                                    lineCap: 'round', lineJoin: 'round'
                                });
                                polyline.on('click', () => selectDay(dayIndex));
                                layerGroup.addLayer(polyline);
                                drawn = true;
                            }
                        }
                    } catch (e) {}
                    if (!drawn) {
                        // Прямая линия между точками, если сервис маршрутизации недоступен
                        try {
                            const straight = L.polyline(placeInfo.map(p => [p.lat, p.lon]), {
                                color: color, weight: 4, opacity: 0.75, dashArray: '2 6',
                                lineCap: 'round', lineJoin: 'round'
                            });
                            straight.on('click', () => selectDay(dayIndex));
                            layerGroup.addLayer(straight);
                        } catch (e) {}
                    }
                }

                layerGroup.addTo(leafletMap);
                allDaysMapLayers[dayIndex] = layerGroup;
            }

            // Fit bounds to ALL points
            if (allBounds.length > 0) {
                try { leafletMap.fitBounds(L.latLngBounds(allBounds), {padding: [50, 50]}); } catch (e) {}
            }

            // Build map legend
            buildMapLegend();

            if (loadingOverlay) loadingOverlay.classList.add('hidden');

            // Select first day
            if (planDays.length > 0) selectDay(0);

            setTimeout(() => { try { leafletMap.invalidateSize(); } catch(e) {} }, 300);
        }

        function highlightDayOnMap(dayIndex) {
            if (!leafletMap) return;
            Object.entries(allDaysMapLayers).forEach(([idx, layerGroup]) => {
                const isSelected = parseInt(idx) === dayIndex;
                layerGroup.eachLayer(layer => {
                    if (layer instanceof L.Polyline && !(layer instanceof L.Marker)) {
                        layer.setStyle({
                            weight: isSelected ? 6 : 3,
                            opacity: isSelected ? 0.9 : 0.25
                        });
                        if (isSelected) layer.bringToFront();
                    } else if (layer instanceof L.Marker) {
                        layer.setOpacity(isSelected ? 1 : 0.35);
                    }
                });
            });
        }

        function buildMapLegend() {
            const legend = document.getElementById('mapLegend');
            // Боковое меню дней отключено: дни переключаются в нижней шторке
            if (legend) { legend.style.display = 'none'; legend.innerHTML = ''; }
            return;
            if (!legend || planDays.length <= 1) { if (legend) legend.style.display = 'none'; return; }
            let html = '';
            planDays.forEach((day, idx) => {
                const color = dayColors[idx % dayColors.length];
                const hasRoute = !!allDaysPlaceInfo[idx];
                html += `<button type="button" class="map-legend-item${idx === 0 ? ' active' : ''}" style="--day-color:${color}" onclick="selectDay(${idx})" ${!hasRoute ? 'disabled' : ''}>
                    <span class="legend-dot" style="background:${color}"></span>
                    <span class="legend-label">День ${day.dayNum}</span>
                </button>`;
            });
            legend.innerHTML = html;
            legend.style.display = 'flex';
        }

        // ===== NEARBY POIs (option A) + CLICK-ANYWHERE (option B) =====
        let nearbyPoisEnabled = false;
        let nearbyPoisLayer = null;
        let nearbyPoisFetchTimer = null;
        let nearbyPoisCache = {};
        let nearbyPoisLastBboxKey = null;
        let nearbyPoisAbortCtl = null;

        function initPoiOverlay() {
            if (!leafletMap || leafletMap._poiInited) return;
            leafletMap._poiInited = true;

            // Move default Leaflet zoom control out of top-left (hidden behind the sidebar)
            try { if (leafletMap.zoomControl) leafletMap.zoomControl.setPosition('bottomright'); } catch (e) {}

            leafletMap.on('click', (e) => {
                openAddPlacePopupAt(e.latlng.lat, e.latlng.lng);
            });
            leafletMap.on('moveend zoomend', () => {
                if (!nearbyPoisEnabled) return;
                clearTimeout(nearbyPoisFetchTimer);
                nearbyPoisFetchTimer = setTimeout(fetchAndRenderNearbyPois, 450);
            });

            if (localStorage.getItem('nearbyPoisEnabled') === '1') {
                setTimeout(() => toggleNearbyPois(true), 600);
            }
        }

        function toggleNearbyPois(forceOn) {
            if (!leafletMap) return;
            const btn = document.getElementById('poiToggleBtn');
            const hint = document.getElementById('poiHint');

            if (forceOn === true) nearbyPoisEnabled = true;
            else if (forceOn === false) nearbyPoisEnabled = false;
            else nearbyPoisEnabled = !nearbyPoisEnabled;

            localStorage.setItem('nearbyPoisEnabled', nearbyPoisEnabled ? '1' : '0');
            if (btn) btn.classList.toggle('active', nearbyPoisEnabled);

            if (nearbyPoisEnabled) {
                if (hint) {
                    hint.hidden = false;
                    setTimeout(() => { hint.hidden = true; }, 4500);
                }
                fetchAndRenderNearbyPois();
            } else {
                if (hint) hint.hidden = true;
                clearNearbyPois();
            }
        }

        function clearNearbyPois() {
            if (nearbyPoisLayer && leafletMap) {
                try { leafletMap.removeLayer(nearbyPoisLayer); } catch (e) {}
            }
            nearbyPoisLayer = null;
            const countEl = document.getElementById('poiToggleCount');
            if (countEl) { countEl.hidden = true; countEl.textContent = ''; }
        }

        async function fetchAndRenderNearbyPois() {
            if (!leafletMap || !nearbyPoisEnabled) return;
            if (leafletMap.getZoom() < 13) {
                clearNearbyPois();
                const countEl = document.getElementById('poiToggleCount');
                if (countEl) { countEl.hidden = false; countEl.textContent = '⊕'; countEl.title = 'Приблизьте карту'; }
                return;
            }
            const b = leafletMap.getBounds();
            const bboxKey = [b.getSouth().toFixed(3), b.getWest().toFixed(3), b.getNorth().toFixed(3), b.getEast().toFixed(3)].join(',');
            if (bboxKey === nearbyPoisLastBboxKey && nearbyPoisLayer) return;
            nearbyPoisLastBboxKey = bboxKey;

            let pois = nearbyPoisCache[bboxKey];
            if (!pois) {
                if (nearbyPoisAbortCtl) nearbyPoisAbortCtl.abort();
                nearbyPoisAbortCtl = new AbortController();
                try {
                    const resp = await fetch('/api/nearby-pois', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({bbox: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], limit: 80}),
                        signal: nearbyPoisAbortCtl.signal
                    });
                    const data = await resp.json();
                    if (!data.success) return;
                    pois = data.pois || [];
                    nearbyPoisCache[bboxKey] = pois;
                } catch (e) { return; }
            }
            renderNearbyPois(pois);
        }

        function isPlaceAlreadyInRoute(poi) {
            const lcName = (poi.name || '').toLowerCase().trim();
            for (const idx in allDaysPlaceInfo) {
                const arr = allDaysPlaceInfo[idx];
                if (!Array.isArray(arr)) continue;
                for (const p of arr) {
                    if ((p.name || '').toLowerCase().trim() === lcName) return true;
                    const dLat = p.lat - poi.lat, dLon = p.lon - poi.lon;
                    const distM = Math.sqrt(dLat*dLat + dLon*dLon) * 111000;
                    if (distM < 50) return true;
                }
            }
            return false;
        }

        function renderNearbyPois(pois) {
            if (nearbyPoisLayer) {
                try { leafletMap.removeLayer(nearbyPoisLayer); } catch (e) {}
            }
            const filtered = (pois || []).filter(p => !isPlaceAlreadyInRoute(p));
            nearbyPoisLayer = L.layerGroup();
            filtered.forEach(poi => {
                const icon = L.divIcon({
                    html: `<div class="poi-suggest-marker">★</div>`,
                    iconSize: [28, 28], iconAnchor: [14, 14],
                    className: 'poi-suggest-icon'
                });
                const marker = L.marker([poi.lat, poi.lon], { icon, zIndexOffset: -100 });
                marker.bindTooltip(poi.name, { direction: 'top', offset: [0, -10], opacity: 0.9 });
                marker.on('click', (e) => {
                    L.DomEvent.stopPropagation(e);
                    openPoiAddPopup(poi);
                });
                nearbyPoisLayer.addLayer(marker);
            });
            nearbyPoisLayer.addTo(leafletMap);
            const countEl = document.getElementById('poiToggleCount');
            if (countEl) {
                countEl.hidden = filtered.length === 0;
                countEl.textContent = filtered.length;
            }
        }

        function buildAddPlacePopupHtml({ name, kind, lat, lon, editableName }) {
            let dayOptions = '';
            const days = planDays.length ? planDays : [{ dayNum: 1 }];
            days.forEach((d, i) => {
                const sel = i === (currentDayIndex || 0) ? ' selected' : '';
                dayOptions += `<option value="${i}"${sel}>День ${d.dayNum || (i+1)}</option>`;
            });
            const safeName = (name || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
            const nameField = editableName
                ? `<input type="text" class="poi-popup-name-input" value="${safeName}" placeholder="Название места">`
                : `<div class="poi-popup-name">${safeName || 'Без названия'}</div>`;
            const kindBadge = kind ? `<span class="poi-popup-kind">${String(kind).replace(/_/g,' ')}</span>` : '';
            return `<div class="poi-popup">
                <div class="poi-popup-photo empty">${kindBadge}</div>
                <div class="poi-popup-body">
                    ${nameField}
                    <div class="poi-popup-coords">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
                    <div class="poi-popup-row">
                        <select class="poi-day-select">${dayOptions}</select>
                        <button class="poi-add-btn" type="button">+ Добавить</button>
                    </div>
                    <div class="poi-add-status"></div>
                </div>
            </div>`;
        }

        function openPoiAddPopup(poi) {
            if (!planDays.length) return;
            const html = buildAddPlacePopupHtml({
                name: poi.name, kind: poi.kind,
                lat: poi.lat, lon: poi.lon, editableName: false
            });
            const popup = L.popup({
                className: 'poi-add-popup',
                closeButton: true, autoClose: true,
                maxWidth: 280, minWidth: 260,
                offset: [0, -10]
            }).setLatLng([poi.lat, poi.lon]).setContent(html).openOn(leafletMap);

            wireAddPopup(popup, { name: poi.name, lat: poi.lat, lon: poi.lon, editable: false });

            fetch('/api/photo', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ place: poi.name, destination: tripData.destination || '' })
            }).then(r => r.json()).then(d => {
                if (!d.success || !d.url) return;
                const wrap = popup.getElement()?.querySelector('.poi-popup');
                const photoEl = wrap?.querySelector('.poi-popup-photo');
                if (!photoEl) return;
                photoEl.classList.remove('empty');
                photoEl.style.backgroundImage = `url('${d.url.replace(/'/g, '%27')}')`;
            }).catch(() => {});
        }

        async function openAddPlacePopupAt(lat, lon) {
            if (!planDays.length) return;
            const interim = `<div class="poi-popup"><div class="poi-popup-body">
                <div class="poi-popup-name">Определяем место…</div>
                <div class="poi-popup-coords">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
            </div></div>`;
            const popup = L.popup({
                className: 'poi-add-popup',
                closeButton: true,
                maxWidth: 280, minWidth: 260,
                offset: [0, -4]
            }).setLatLng([lat, lon]).setContent(interim).openOn(leafletMap);

            let resolvedName = '';
            try {
                const resp = await fetch('/api/reverse-geocode', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ lat, lon })
                });
                const d = await resp.json();
                if (d.success && d.name) resolvedName = d.name;
            } catch (e) {}

            const html = buildAddPlacePopupHtml({
                name: resolvedName, kind: null,
                lat, lon, editableName: true
            });
            popup.setContent(html);
            wireAddPopup(popup, { name: resolvedName, lat, lon, editable: true });
        }

        function wireAddPopup(popup, { name, lat, lon, editable }) {
            setTimeout(() => {
                const el = popup.getElement();
                if (!el) return;
                const wrap = el.querySelector('.poi-popup');
                if (!wrap) return;
                const btn = wrap.querySelector('.poi-add-btn');
                const sel = wrap.querySelector('.poi-day-select');
                const input = wrap.querySelector('.poi-popup-name-input');
                const status = wrap.querySelector('.poi-add-status');
                if (!btn) return;
                btn.onclick = async () => {
                    const finalName = editable && input ? (input.value || '').trim() : name;
                    if (!finalName) {
                        if (status) { status.classList.add('error'); status.textContent = 'Введите название'; }
                        return;
                    }
                    const dayIdx = sel ? parseInt(sel.value, 10) : 0;
                    btn.disabled = true;
                    if (status) { status.classList.remove('error'); status.textContent = 'Добавляем...'; }
                    try {
                        await addPlaceAtCoords(finalName, lat, lon, dayIdx);
                        if (status) status.textContent = '✓ Добавлено';
                        setTimeout(() => { try { leafletMap.closePopup(popup); } catch (_) {} }, 800);
                        if (nearbyPoisEnabled) {
                            nearbyPoisLastBboxKey = null;
                            fetchAndRenderNearbyPois();
                        }
                    } catch (err) {
                        btn.disabled = false;
                        if (status) { status.classList.add('error'); status.textContent = (err && err.message) || 'Не удалось добавить'; }
                    }
                };
            }, 0);
        }

        async function addPlaceAtCoords(name, lat, lon, dayIndex) {
            if (!planDays[dayIndex]) throw new Error('Нет такого дня');
            const targetArr = Array.isArray(allDaysPlaceInfo[dayIndex]) ? allDaysPlaceInfo[dayIndex] : [];
            const lc = name.toLowerCase().trim();
            if (targetArr.some(p => (p.name || '').toLowerCase().trim() === lc)) {
                throw new Error('Уже есть в этом дне');
            }
            targetArr.push({ num: targetArr.length + 1, name, lat, lon });
            allDaysPlaceInfo[dayIndex] = targetArr;

            const day = planDays[dayIndex];
            if (day) {
                const lines = (day.content || '').split('\n');
                const nextNum = targetArr.length;
                lines.push(`${nextNum}. ${name}`);
                lines.push('Описание: Добавлено вручную с карты.');
                lines.push('Цена: бесплатно');
                day.content = lines.join('\n');
            }

            if (dayIndex === currentDayIndex) {
                currentPlaceInfo = targetArr;
                await redrawMapFromCurrentPlaces(dayIndex);
            } else {
                await redrawDayLayerOnMap(dayIndex);
            }
            try { buildMapLegend(); } catch (e) {}
        }

        async function redrawDayLayerOnMap(dayIndex) {
            if (!leafletMap) return;
            const arr = allDaysPlaceInfo[dayIndex];
            if (!Array.isArray(arr)) return;
            const color = dayColors[dayIndex % dayColors.length];

            if (allDaysMapLayers[dayIndex]) {
                try { leafletMap.removeLayer(allDaysMapLayers[dayIndex]); } catch (e) {}
            }
            const layerGroup = L.layerGroup();
            arr.forEach((p, i) => {
                p.num = i + 1;
                try {
                    const icon = L.divIcon({
                        html: `<div class="nm-pin" style="background:${color};animation-delay:${(p.num-1)*0.06}s"><span>${p.num}</span></div>`,
                        iconSize: [36, 36], iconAnchor: [18, 36],
                        className: 'numbered-marker'
                    });
                    const marker = L.marker([p.lat, p.lon], { icon })
                        .bindPopup(`<b>День ${planDays[dayIndex]?.dayNum || dayIndex+1}: ${p.num}. ${p.name}</b>`);
                    marker.on('click', () => selectDay(dayIndex));
                    layerGroup.addLayer(marker);
                } catch (e) {}
            });

            if (arr.length >= 2) {
                try {
                    const routePoints = arr.map(p => ({lat: p.lat, lon: p.lon}));
                    const resp = await fetch('/api/route', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({points: routePoints, profile: 'foot'})
                    });
                    if (resp.ok) {
                        const rd = await resp.json();
                        if (rd.success && rd.geometry?.coordinates) {
                            rd.distance_km = Math.round(rd.distance / 100) / 10;
                            rd.duration_min = Math.max(1, Math.round(rd.duration / 60));
                            allDaysRouteData[dayIndex] = rd;
                            const routeCoords = rd.geometry.coordinates.map(c => [c[1], c[0]]);
                            const polyline = L.polyline(routeCoords, {
                                color: color, weight: 5, opacity: 0.8,
                                lineCap: 'round', lineJoin: 'round'
                            });
                            polyline.on('click', () => selectDay(dayIndex));
                            layerGroup.addLayer(polyline);
                        }
                    }
                } catch (e) {}
            }

            layerGroup.addTo(leafletMap);
            allDaysMapLayers[dayIndex] = layerGroup;
            highlightDayOnMap(currentDayIndex);
        }

        async function extractAndShowMap(dayText, dayNum, dayIndex, candidatePlaces=null) {
            let places = [];
            if (Array.isArray(candidatePlaces) && candidatePlaces.length > 0) {
                places = candidatePlaces;
            } else {
                // Не отправляем случайный текст на геокодинг
                console.warn('[extractAndShowMap] Не удалось извлечь места из текста дня');
                return;
            }
            
            if (places.length === 0) return;

            const coords = [];
            const placeInfo = [];
            let pointNum = 1;
            
            // Параллельный геокодинг всех мест — значительно быстрее
            // AbortController: таймаут 10с на каждый запрос, чтобы не зависать
            const geocodePromises = places.filter(p => p.trim()).map(async (place) => {
                const trimmed = place.trim();
                try {
                    const geoBody = {place: trimmed, destination: tripData.destination || ''};
                    if (destCoords) {
                        geoBody.destLat = destCoords.lat;
                        geoBody.destLon = destCoords.lon;
                    }
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 10000);
                    const resp = await fetch('/api/geocode', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(geoBody),
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);
                    if (!resp.ok) return null;
                    const data = await resp.json();
                    if (data.success && data.lat && data.lon) {
                        return { name: trimmed, lat: data.lat, lon: data.lon };
                    }
                } catch (e) { }
                return null;
            });
            
            const results = await Promise.all(geocodePromises);
            
            // Собираем результаты с сохранением порядка
            const rawPlaces = [];
            for (const result of results) {
                if (result) {
                    rawPlaces.push(result);
                }
            }

            if (rawPlaces.length === 0) return;

            // === Серверная оптимизация маршрута (TSP + 2-opt) ===
            let optimized = rawPlaces;
            try {
                const optResp = await fetch('/api/optimize-day', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({places: rawPlaces})
                });
                const optData = await optResp.json();
                if (optData.success && optData.places && optData.places.length > 0) {
                    optimized = optData.places;
                    // Показываем общее расстояние маршрута
                    const totalKm = (optData.totalDistanceM / 1000).toFixed(1);
                    console.log(`[optimize-day] Day ${dayNum}: ${optimized.length} places, ${totalKm} km total walking`);
                    // Сохраняем сегменты для отображения времени в пути
                    if (optData.segments) {
                        window._dayRouteSegments = window._dayRouteSegments || {};
                        window._dayRouteSegments[dayIndex] = optData.segments;
                    }
                }
            } catch (optErr) {
                console.warn('[optimize-day] Server optimization failed, using client-side TSP:', optErr);
                optimized = tspNearestNeighbor(rawPlaces);
            }
            
            for (let i = 0; i < optimized.length; i++) {
                coords.push([optimized[i].lat, optimized[i].lon]);
                placeInfo.push({
                    num: i + 1,
                    name: optimized[i].name,
                    lat: optimized[i].lat,
                    lon: optimized[i].lon
                });
            }

            if (coords.length === 0) return;

            if (typeof L === 'undefined') return;

            const mapEl = document.getElementById('leafletMap');
            if (!mapEl) return;

            if (!leafletMap) {
                try {
                    const initialCoord = coords[0] || [48.8566, 2.3522];
                    leafletMap = L.map(mapEl).setView(initialCoord, 13);
                    addMapTileLayer(leafletMap);
                } catch (e) {
                    leafletMap = null;
                    return;
                }
            } else {
                leafletMap.eachLayer(layer => {
                    if (layer instanceof L.Marker || layer instanceof L.Polyline) {
                        leafletMap.removeLayer(layer);
                    }
                });
            }

            placeInfo.forEach(place => {
                try {
                    const icon = L.divIcon({
                        html: `<div class="nm-pin" style="background:#005F60;animation-delay:${(place.num-1)*0.06}s"><span>${place.num}</span></div>`,
                        iconSize: [36, 36], iconAnchor: [18, 36],
                        className: 'numbered-marker'
                    });
                    L.marker([place.lat, place.lon], {icon})
                        .addTo(leafletMap)
                        .bindPopup(`<b>${place.num}. ${place.name}</b>`);
                } catch (e) { }
            });

            // Строим маршрут между точками по порядку
            let routeData = null;
            if (coords.length >= 2) {
                try {
                    const routePoints = placeInfo.map(p => ({lat: p.lat, lon: p.lon}));
                    const resp = await fetch('/api/route', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({points: routePoints, profile: 'foot'})
                    });
                    if (resp.ok) {
                        routeData = await resp.json();
                        if (routeData.success && routeData.geometry && routeData.geometry.coordinates) {
                            // Конвертируем в удобный формат для showPlacesInfo
                            routeData.distance_km = Math.round(routeData.distance / 100) / 10;
                            routeData.duration_min = Math.max(1, Math.round(routeData.duration / 60));
                            // OSRM возвращает [lon, lat], Leaflet ожидает [lat, lon]
                            const routeCoords = routeData.geometry.coordinates.map(c => [c[1], c[0]]);
                            L.polyline(routeCoords, {
                                color: '#005F60',
                                weight: 4,
                                opacity: 0.75,
                                dashArray: '8, 12',
                                lineCap: 'round'
                            }).addTo(leafletMap);
                        }
                    }
                } catch (e) { }
            }

            try {
                leafletMap.fitBounds(L.latLngBounds(coords), {padding: [50, 50]});
                setTimeout(() => {
                    try {
                        leafletMap.invalidateSize();
                    } catch(e) { }
                }, 250);
            } catch (e) { }

            showPlacesInfo(placeInfo, dayIndex, routeData);
        }


        function extractPlaceBlurb(placeName, dayIdx) {
            const raw = planDays[dayIdx]?.content || '';
            if (!raw || !placeName) return '';
            const shortName = placeName.substring(0, 18).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const lines = raw.split('\n');
            let start = -1;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(shortName.toLowerCase().replace(/\\/g, ''))) {
                    start = i;
                    break;
                }
            }
            if (start < 0) {
                const core = extractCoreName(placeName).substring(0, 16).toLowerCase();
                start = lines.findIndex(l => l.toLowerCase().includes(core));
            }
            if (start < 0) return '';
            const blob = [];
            for (let i = start + 1; i < Math.min(lines.length, start + 6); i++) {
                const t = lines[i].trim();
                if (!t) continue;
                if (/^\d+[.\)]\s/.test(t)) break;
                if (/^(цена|вход|бесплатно|от предыдущего|время:|на посещение)/i.test(t)) continue;
                if (/^(утро|день|вечер|отели|бюджет|итого)/i.test(t)) break;
                const clean = t.replace(/^описание:\s*/i, '');
                if (clean.length > 25) blob.push(clean);
            }
            return blob.join(' ').replace(/\s+/g, ' ').slice(0, 280);
        }

        function extractDayStory(raw, placeCount) {
            const lines = (raw || '').split('\n').map(l => l.trim()).filter(Boolean);
            let title = '';
            let first = '';
            let startT = '';
            let endT = '';
            const times = [];
            for (const t of lines) {
                if (!title && /^День\s+\d+/i.test(t)) {
                    title = t.replace(/^День\s+\d+\s*[—\-–:]?\s*/i, '');
                    continue;
                }
                const tm = t.match(/(\d{1,2}[:.]\d{2})/g);
                if (tm) times.push(...tm);
                if (!first && t.length > 40 && !/^\d+[.\)]/.test(t) && !/цена|бюджет|итого/i.test(t)) {
                    first = t.replace(/^описание:\s*/i, '');
                }
            }
            if (times.length) {
                startT = times[0].replace('.', ':');
                endT = times[times.length - 1].replace('.', ':');
            }
            const span = startT && endT ? `${startT}–${endT}` : '';
            const blurb = (title ? title + '. ' : '') + (first || `В программе ${placeCount} точек, день построен как пеший маршрут.`);
            return { span, blurb: blurb.slice(0, 220) };
        }

        function showPlacesInfo(placeInfo, dayIndex, routeData = null) {
            currentDayIndex = dayIndex;
            currentPlaceInfo = placeInfo;
            const summaryDiv = document.getElementById('routeSummary');
            const cardsDiv = document.getElementById('placeCards');

            // Route Summary Badge — всегда показываем день, даже без геометрии
            const walkKm = routeData && routeData.distance_km ? routeData.distance_km : '';
            const walkMin = routeData && routeData.duration_min ? routeData.duration_min : '';
            const dayMeta = extractDayStory(planDays[dayIndex]?.content || '', placeInfo.length);
            summaryDiv.style.display = 'flex';
            summaryDiv.innerHTML = `
                <div class="stat"><span class="icon">📍</span><span class="value">${placeInfo.length} мест</span></div>
                <div class="divider"></div>
                <div class="stat"><span class="icon">⏱</span><span class="value">${dayMeta.span || (walkMin ? walkMin + ' мин' : 'весь день')}</span></div>
                ${walkKm ? `<div class="divider"></div><div class="stat"><span class="icon">🚶</span><span class="value">${walkKm} км</span></div>` : ''}
            `;
            let storyHtml = '';
            if (dayMeta.blurb) {
                storyHtml = `<div class="day-story">${esc(dayMeta.blurb)}</div>`;
            }

            // Place Cards with walking segments (React RouteScreen layout)
            const legs = (routeData && routeData.legs) || [];
            let cardsHtml = storyHtml || '';

            // SVG icons for meta & actions
            const clockSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
            const mapPinSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';
            const starSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="#2D68C4" stroke="#2D68C4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
            const externalLinkSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
            const refreshCwSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
            // Time-of-day icons (Sunrise, Sun, Moon)
            const sunriseSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>';
            const sunSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
            const moonSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

            // ─── Determine time-of-day for each place from raw day text ───
            function getPlaceTimeOfDay(placeName, dayIdx) {
                const raw = planDays[dayIdx]?.content || '';
                const lines = raw.split('\n');
                let currentBlock = '';
                const shortName = placeName.substring(0, 15).toLowerCase();
                for (const line of lines) {
                    const t = line.trim();
                    if (/УТРО/i.test(t)) currentBlock = 'morning';
                    else if (/ДЕНЬ/i.test(t) && !/^День\s+\d/i.test(t)) currentBlock = 'day';
                    else if (/ВЕЧЕР/i.test(t)) currentBlock = 'evening';
                    if (t.toLowerCase().includes(shortName)) return currentBlock;
                }
                return currentBlock;
            }
            function todIcon(tod) {
                if (tod === 'morning') return sunriseSvg;
                if (tod === 'day') return sunSvg;
                if (tod === 'evening') return moonSvg;
                return '';
            }
            function todLabel(tod) {
                if (tod === 'morning') return 'Утро';
                if (tod === 'day') return 'День';
                if (tod === 'evening') return 'Вечер';
                return '';
            }

            // ─── Try extract rating from day text ───
            function extractRating(placeName, dayIdx) {
                const raw = planDays[dayIdx]?.content || '';
                const shortName = placeName.substring(0, 15).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // Patterns: "4.8/5", "⭐ 4.8", "рейтинг 4.8", "Rating: 4.8"
                const ratingRe = new RegExp(shortName + '[^\\n]{0,120}?(?:⭐\\s*|рейтинг[:\\s]*|rating[:\\s]*|)(\\d[.,]\\d)(?:\\s*/\\s*5)?', 'i');
                const m = raw.match(ratingRe);
                if (m) {
                    const val = parseFloat(m[1].replace(',', '.'));
                    if (val >= 1.0 && val <= 5.0) return val.toFixed(1);
                }
                return '';
            }

            // ─── Try extract reviews count from day text ───
            function extractReviews(placeName, dayIdx) {
                const raw = planDays[dayIdx]?.content || '';
                const shortName = placeName.substring(0, 15).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const revRe = new RegExp(shortName + '[^\\n]{0,120}?(\\d[\\d\\s.,]*\\d*)\\s*(?:отзыв|review|оценк)', 'i');
                const m = raw.match(revRe);
                if (m) {
                    const num = m[1].replace(/[\s.]/g, '').replace(',', '');
                    const n = parseInt(num, 10);
                    if (n > 0 && n < 10000000) return n;
                }
                return 0;
            }

            placeInfo.forEach((p, idx) => {
                // Extract time hint and price from raw plan content
                let timeHint = '';
                try {
                    const txt = (planDays[dayIndex]?.content) || '';
                    const shortName = p.name.substring(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const re = new RegExp('(\\d{1,2}[:.:]\\d{2})\\s*[-–—]\\s*(\\d{1,2}[:.:]\\d{2})[^\\n]*' + shortName, 'i');
                    const tm = txt.match(re);
                    if (tm) {
                        const [h1, m1] = tm[1].split(/[:.]/).map(Number);
                        const [h2, m2] = tm[2].split(/[:.]/).map(Number);
                        const mins = (h2 * 60 + m2) - (h1 * 60 + m1);
                        if (mins > 0 && mins < 480) timeHint = `~${mins} мин`;
                    }
                } catch(e) {}

                // Extract address from name (parentheses content)
                let displayName = p.name;
                let addressHint = '';
                const addrMatch = p.name.match(/^([^(]+)\s*\(([^)]+)\)/);
                if (addrMatch) {
                    displayName = addrMatch[1].trim();
                    addressHint = addrMatch[2].trim();
                }

                // Time-of-day, rating, reviews
                const tod = getPlaceTimeOfDay(p.name, dayIndex);
                const rating = extractRating(p.name, dayIndex);
                const reviews = extractReviews(p.name, dayIndex);

                const coreName = extractCoreName(p.name);
                const city = tripData.destination || '';
                const searchGoogle = encodeURIComponent(coreName + ' ' + city);
                const searchWiki = encodeURIComponent(coreName);
                const searchTA = encodeURIComponent(coreName + ' ' + city);

                cardsHtml += `<div class="place-card" draggable="true" data-place-idx="${idx}" style="animation: cardSlideUp 0.3s ease-out ${idx * 0.08}s both;">
                    <div class="place-top">
                        <div class="drag-handle" title="Зажмите и перетащите для изменения порядка"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg></div>
                        <div class="place-img-wrap" id="photo-${dayIndex}-${idx}" data-name="${p.name}" role="button" tabindex="0" aria-label="Подробнее о месте" onclick="event.stopPropagation(); openPlaceSheet(this.getAttribute('data-name'), this.querySelector('img.place-photo')?.getAttribute('data-full') || '')">
                            <span class="place-img-icon">${mapPinSvg}</span>
                        </div>
                        <div class="place-details">
                            <div class="place-name-row">
                                <div class="place-name">${displayName}</div>
                                ${rating ? `<div class="place-rating">${starSvg}<span>${rating}</span></div>` : ''}
                            </div>
                            ${reviews ? `<div class="place-reviews">${reviews.toLocaleString()} отзывов</div>` : ''}
                            ${addressHint ? `<div class="place-address">${addressHint}</div>` : ''}
                            ${(() => { const blurb = extractPlaceBlurb(p.name, dayIndex); return blurb ? `<div class="place-desc">${esc(blurb)}</div>` : ''; })()}
                            <div class="place-meta">
                                ${timeHint ? `<div class="place-meta-item">${clockSvg} ${timeHint}</div>` : ''}
                                ${tod ? `<div class="place-meta-item tod">${todIcon(tod)}<span>${todLabel(tod)}</span></div>` : ''}
                            </div>
                        </div>
                    </div>
                    <div class="place-actions">
                        <a class="place-action-btn link" href="https://en.wikipedia.org/wiki/Special:Search?search=${searchWiki}" target="_blank">${externalLinkSvg} Wiki</a>
                        <a class="place-action-btn link" href="https://www.tripadvisor.com/Search?q=${searchTA}" target="_blank">${externalLinkSvg} TripAdvisor</a>
                        <button class="place-action-btn swap icon-only" title="Заменить место" aria-label="Заменить место" onclick="swapPlace(${dayIndex}, ${idx}, this)">${refreshCwSvg}</button>
                        ${planDays.length > 1 ? `<button class="place-action-btn move icon-only" title="Перенести в другой день" aria-label="Перенести в другой день" onclick="toggleMoveDayDropdown(this, ${dayIndex}, ${idx})"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 8 4 4-4 4"/><path d="M2 12h20"/></svg>${buildMoveDayDropdown(dayIndex, idx)}</button>` : ''}
                        <button class="place-action-btn delete" onclick="deletePlace(${dayIndex}, ${idx}, this)"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg> Удалить</button>
                    </div>
                </div>`;

                // Walking segment connector (between points)
                if (idx < placeInfo.length - 1 && legs[idx]) {
                    const legDist = Math.round(legs[idx].distance / 100) / 10;
                    const legMin = Math.max(1, Math.round(legs[idx].duration / 60));
                    cardsHtml += `<div class="segment-connector">
                        <div class="seg-line"></div>
                        <div class="seg-info">🚶 ${legMin} мин · ${legDist} км</div>
                    </div>`;
                }
            });

            cardsDiv.innerHTML = cardsHtml;
            cardsDiv.querySelectorAll('.place-card').forEach((card) => {
                card.addEventListener('click', (e) => {
                    if (e.target.closest('button,a,.drag-handle,.place-actions')) return;
                    focusPlaceOnMap(dayIndex, Number(card.dataset.placeIdx));
                });
            });

            // Store route data for re-rendering after delete/swap
            currentRouteData = routeData;

            // === Drag-and-drop для перетаскивания мест ===
            initPlaceCardsDragAndDrop(cardsDiv, dayIndex);

            // Async load photos for each place
            loadPlacePhotos(placeInfo, dayIndex);
        }

        // ===== DRAG-AND-DROP для перестановки мест =====
        function initPlaceCardsDragAndDrop(container, dayIndex) {
            let dragSrcIdx = null;

            const cards = container.querySelectorAll('.place-card[draggable="true"]');
            cards.forEach(card => {
                // --- Desktop: HTML5 Drag API ---
                card.addEventListener('dragstart', (e) => {
                    dragSrcIdx = parseInt(card.dataset.placeIdx);
                    card.classList.add('dragging');
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', dragSrcIdx);
                });

                card.addEventListener('dragend', () => {
                    card.classList.remove('dragging');
                    container.querySelectorAll('.place-card').forEach(c => c.classList.remove('drag-over'));
                });

                card.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    // Highlight drop target
                    container.querySelectorAll('.place-card').forEach(c => c.classList.remove('drag-over'));
                    card.classList.add('drag-over');
                });

                card.addEventListener('dragleave', () => {
                    card.classList.remove('drag-over');
                });

                card.addEventListener('drop', (e) => {
                    e.preventDefault();
                    card.classList.remove('drag-over');
                    const dropIdx = parseInt(card.dataset.placeIdx);
                    if (dragSrcIdx !== null && dragSrcIdx !== dropIdx) {
                        reorderPlace(dayIndex, dragSrcIdx, dropIdx);
                    }
                    dragSrcIdx = null;
                });

                // --- Mobile: Touch events (через drag-handle) ---
                const handle = card.querySelector('.drag-handle');
                if (!handle) return;

                let touchStartY = 0;
                let touchCurrentY = 0;
                let touchActive = false;
                let clone = null;
                let allCards = [];

                handle.addEventListener('touchstart', (e) => {
                    e.preventDefault();
                    touchActive = true;
                    touchStartY = e.touches[0].clientY;
                    dragSrcIdx = parseInt(card.dataset.placeIdx);
                    card.classList.add('dragging');

                    // Create floating clone
                    clone = card.cloneNode(true);
                    clone.style.cssText = `
                        position: fixed; z-index: 9999; pointer-events: none;
                        width: ${card.offsetWidth}px; opacity: 0.85;
                        box-shadow: 0 12px 35px rgba(0,0,0,0.2);
                        transform: scale(1.02); transition: none;
                        left: ${card.getBoundingClientRect().left}px;
                        top: ${card.getBoundingClientRect().top}px;
                    `;
                    document.body.appendChild(clone);

                    allCards = [...container.querySelectorAll('.place-card[draggable="true"]')];
                }, { passive: false });

                handle.addEventListener('touchmove', (e) => {
                    if (!touchActive || !clone) return;
                    e.preventDefault();
                    touchCurrentY = e.touches[0].clientY;
                    const dy = touchCurrentY - touchStartY;
                    const rect = card.getBoundingClientRect();
                    clone.style.top = (rect.top + dy) + 'px';

                    // Highlight card under finger
                    container.querySelectorAll('.place-card').forEach(c => c.classList.remove('drag-over'));
                    for (const c of allCards) {
                        const cr = c.getBoundingClientRect();
                        if (touchCurrentY >= cr.top && touchCurrentY <= cr.bottom && c !== card) {
                            c.classList.add('drag-over');
                            break;
                        }
                    }
                }, { passive: false });

                handle.addEventListener('touchend', () => {
                    if (!touchActive) return;
                    touchActive = false;
                    card.classList.remove('dragging');
                    if (clone) { clone.remove(); clone = null; }

                    // Find drop target
                    let dropIdx = null;
                    for (const c of allCards) {
                        const cr = c.getBoundingClientRect();
                        if (touchCurrentY >= cr.top && touchCurrentY <= cr.bottom && c !== card) {
                            dropIdx = parseInt(c.dataset.placeIdx);
                            break;
                        }
                    }
                    container.querySelectorAll('.place-card').forEach(c => c.classList.remove('drag-over'));

                    if (dropIdx !== null && dragSrcIdx !== null && dragSrcIdx !== dropIdx) {
                        reorderPlace(dayIndex, dragSrcIdx, dropIdx);
                    }
                    dragSrcIdx = null;
                });
            });
        }

        // Переставляем место с позиции fromIdx на позицию toIdx и перерисовываем
        async function reorderPlace(dayIndex, fromIdx, toIdx) {
            if (fromIdx === toIdx) return;
            if (!currentPlaceInfo || fromIdx >= currentPlaceInfo.length || toIdx >= currentPlaceInfo.length) return;

            // Перемещаем элемент в массиве
            const [moved] = currentPlaceInfo.splice(fromIdx, 1);
            currentPlaceInfo.splice(toIdx, 0, moved);

            // Перенумеруем
            currentPlaceInfo.forEach((p, i) => p.num = i + 1);
            writePlacesBack(dayIndex, currentPlaceInfo);

            // Перерисовываем карту и карточки с новым маршрутом
            await redrawMapFromCurrentPlaces(dayIndex);
        }
        window.reorderPlace = reorderPlace;

        // ===== PLACE PHOTOS & DETAILS (Google Places API) =====
        const photoCache = {};
        const placeDetailsCache = {};

        async function loadPlacePhotos(placeInfo, dayIndex) {
            const destination = tripData.destination || '';
            placeInfo.forEach((p, idx) => {
                const elId = `photo-${dayIndex}-${idx}`;
                const cacheKey = p.name.toLowerCase();

                if (photoCache[cacheKey]) {
                    setPhotoEl(elId, photoCache[cacheKey]);
                    return;
                }

                if (placeDetailsCache[cacheKey]) {
                    const details = placeDetailsCache[cacheKey];
                    if (details.photos && details.photos.length > 0) {
                        const photoUrl = details.photos[0].url;
                        photoCache[cacheKey] = photoUrl;
                        setPhotoEl(elId, photoUrl);
                    }
                    updatePlaceHours(dayIndex, idx, details);
                    return;
                }

                // Fire-and-forget per card — no await, parallel loading
                // Для поиска фото используем английское название (до скобок с русским)
                const photoQuery = p.name.split(/\s*\(/)[0].trim() || p.name;
                
                // Сначала попробуем Google Places API для фото и деталей
                fetch('/api/place-details', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ 
                        query: photoQuery, 
                        lat: p.lat, 
                        lon: p.lon 
                    })
                })
                .then(r => r.json())
                .then(data => {
                    if (data.success && data.details) {
                        const details = data.details;
                        placeDetailsCache[cacheKey] = details;
                        
                        // Установим фото из Places API
                        if (details.photos && details.photos.length > 0) {
                            const photoUrl = details.photos[0].url;
                            photoCache[cacheKey] = photoUrl;
                            setPhotoEl(elId, photoUrl);
                        }
                        
                        // Обновим часы работы в карточке
                        updatePlaceHours(dayIndex, idx, details);
                        
                        return; // Не идем дальше, если Places API сработал
                    }
                    
                    // Fallback to Wikimedia API
                    return fetch('/api/photo', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ place: photoQuery, destination })
                    });
                })
                .then(response => {
                    if (!response) return; // Уже обработали Places API
                    return response.json();
                })
                .then(data => {
                    if (data && data.success && data.url) {
                        photoCache[cacheKey] = data.url;
                        setPhotoEl(elId, data.url);
                    }
                })
                .catch(() => {});
            });
        }

        function setPhotoEl(elId, url) {
            const el = document.getElementById(elId);
            if (!el) return;
            const placeName = el.getAttribute('data-name') || '';
            
            // New layout: place-img-wrap contains icon + overlaid photo
            if (el.classList.contains('place-img-wrap')) {
                const img = document.createElement('img');
                img.src = url;
                img.className = 'place-photo';
                img.alt = placeName;
                img.setAttribute('data-full', url);
                img.setAttribute('data-name', placeName);
                img.onload = () => img.classList.add('loaded');
                img.onerror = () => img.remove();
                img.onclick = (e) => { e.stopPropagation(); openPlaceSheet(placeName, url); };
                el.appendChild(img);
            } else {
                // Legacy fallback: replace element entirely
                const img = document.createElement('img');
                img.src = url;
                img.className = 'place-photo';
                img.alt = placeName;
                img.setAttribute('data-full', url);
                img.setAttribute('data-name', placeName);
                img.onload = () => img.classList.add('loaded');
                img.onerror = () => img.remove();
                img.onclick = () => openLightbox(img);
                el.replaceWith(img);
            }
        }

        function updatePlaceHours(dayIndex, placeIdx, details) {
            const card = document.querySelector(`.place-card[data-place-idx="${placeIdx}"]`);
            if (!card) return;
            
            const metaEl = card.querySelector('.place-meta');
            if (!metaEl) return;
            
            // Удалим существующие часы работы
            const existingHours = metaEl.querySelector('.place-hours');
            if (existingHours) existingHours.remove();
            
            // Добавим новые часы работы
            if (details.opening_hours && details.opening_hours.weekday_text) {
                const hoursDiv = document.createElement('div');
                hoursDiv.className = 'place-meta-item place-hours';
                hoursDiv.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/>
                    </svg>
                    <span>${details.opening_hours.open_now ? 'Открыто' : 'Закрыто'}</span>
                `;
                
                // Добавим tooltip с полным расписанием
                hoursDiv.title = details.opening_hours.weekday_text.join('\n');
                
                metaEl.appendChild(hoursDiv);
            }
        }

        function openLightbox(img) {
            const overlay = document.getElementById('lightboxOverlay');
            const lbImg = document.getElementById('lightboxImg');
            const caption = document.getElementById('lightboxCaption');
            lbImg.src = img.getAttribute('data-full') || img.src;
            caption.textContent = img.getAttribute('data-name') || '';
            overlay.classList.add('active');
            document.body.style.overflow = 'hidden';
        }


        // ===== Карточка места (шторка с фото и описанием) =====
        let _placeSheetPhotos = [];
        let _placeSheetIdx = 0;

        function openPlaceSheet(name, firstPhoto) {
            const overlay = document.getElementById('placeSheetOverlay');
            if (!overlay) return;
            const cleanName = String(name || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim() || 'Место';
            document.getElementById('placeSheetTitle').textContent = cleanName;
            const descEl = document.getElementById('placeSheetDesc');
            const galEl = document.getElementById('placeSheetGallery');
            const addrEl = document.getElementById('placeSheetAddr');
            // Сразу показываем локальное описание из плана — мгновенно.
            // Когда придёт развёрнутый текст из Википедии — заменим.
            descEl.textContent = placeSheetFallbackDesc(cleanName);
            addrEl.textContent = tripData.destination || '';
            _placeSheetPhotos = firstPhoto ? [firstPhoto] : [];
            _placeSheetIdx = 0;
            renderPlaceSheetGallery();
            overlay.classList.add('active');
            document.body.classList.add('place-sheet-open');
            if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');

            // Описание из Википедии
            fetch('/api/place-info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ place: cleanName, destination: tripData.destination || '' })
            })
            .then(r => r.json())
            .then(data => {
                if (!data || !data.success || !data.extract) return; // остаётся локальное описание
                descEl.textContent = data.extract;
                if (Array.isArray(data.photos) && data.photos.length) {
                    const known = new Set(_placeSheetPhotos);
                    data.photos.forEach(u => { if (!known.has(u)) { known.add(u); _placeSheetPhotos.push(u); } });
                    renderPlaceSheetGallery();
                }
                if (data.address) addrEl.textContent = data.address;
            })
            .catch(() => { /* остаётся локальное описание */ });
        }

        // Локальный фолбэк описания: ищем место в плане поездки и эталонных маршрутах
        function placeSheetFallbackDesc(name) {
            const n = String(name || '').toLowerCase();
            // ищем в плане текущей поездки
            for (const d of (planDays || [])) {
                const pts = d.jsonPlaces || [];
                for (const p of pts) {
                    if (String(p.name || '').toLowerCase().includes(n) || n.includes(String(p.name || '').toLowerCase().slice(0, 14))) {
                        if (p.description) return p.description;
                    }
                }
                const txt = d.content || '';
                const i = txt.toLowerCase().indexOf(n.slice(0, 16));
                if (i >= 0) {
                    const chunk = txt.slice(i, i + 400).split('\n').filter(l => l.trim() && !l.startsWith('Время:')).slice(0, 4).join(' ');
                    if (chunk.trim()) return chunk.trim();
                }
            }
            return 'Точка маршрута: ' + (tripData.destination || '') + '. Подробности смотрите в плане дня.';
        }

        function renderPlaceSheetGallery() {
            const galEl = document.getElementById('placeSheetGallery');
            if (!galEl) return;
            if (!_placeSheetPhotos.length) {
                // Фолбэк: фото направления из эталонного маршрута
                const routeImg = (exampleRoutes.find(r => (r.destination || '').includes(tripData.city || '___')) || {}).img;
                if (routeImg) { _placeSheetPhotos = [routeImg]; }
                else {
                    galEl.innerHTML = '<div class="place-sheet-nophoto">Фото этого места скоро появятся</div>';
                    return;
                }
            }
            galEl.innerHTML = _placeSheetPhotos.map((u, i) =>
                `<img src="${u}" class="place-sheet-thumb${i === _placeSheetIdx ? ' active' : ''}" alt="" loading="lazy" onclick="event.stopPropagation(); placeSheetGo(${i})" onerror="this.remove()">`
            ).join('');
            placeSheetGo(_placeSheetIdx);
        }

        function placeSheetGo(i) {
            if (!_placeSheetPhotos.length) return;
            _placeSheetIdx = Math.max(0, Math.min(i, _placeSheetPhotos.length - 1));
            const main = document.getElementById('placeSheetMain');
            if (main) {
                main.src = _placeSheetPhotos[_placeSheetIdx];
                main.onerror = () => { main.style.visibility = 'hidden'; };
                main.onload = () => { main.style.visibility = 'visible'; };
            }
            document.querySelectorAll('.place-sheet-thumb').forEach((t, j) => t.classList.toggle('active', j === _placeSheetIdx));
            const counter = document.getElementById('placeSheetCounter');
            if (counter) counter.textContent = (_placeSheetIdx + 1) + ' / ' + _placeSheetPhotos.length;
        }

        function placeSheetNav(dir) {
            placeSheetGo((_placeSheetIdx + dir + _placeSheetPhotos.length) % _placeSheetPhotos.length);
        }

        function closePlaceSheet() {
            const overlay = document.getElementById('placeSheetOverlay');
            if (overlay) overlay.classList.remove('active');
            document.body.classList.remove('place-sheet-open');
        }

        window.openPlaceSheet = openPlaceSheet;
        window.closePlaceSheet = closePlaceSheet;
        window.placeSheetGo = placeSheetGo;
        window.placeSheetNav = placeSheetNav;

        function closeLightbox() {
            const overlay = document.getElementById('lightboxOverlay');
            overlay.classList.remove('active');
            document.body.style.overflow = '';
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeLightbox();
        });

        async function redrawMapFromCurrentPlaces(dayIndex) {
            if (!leafletMap) {
                showPlacesInfo(currentPlaceInfo, dayIndex, currentRouteData);
                return;
            }

            const color = dayColors[dayIndex % dayColors.length];

            // Remove old layer group for this day (keep other days)
            if (allDaysMapLayers[dayIndex]) {
                try { leafletMap.removeLayer(allDaysMapLayers[dayIndex]); } catch(e) {}
            }

            // Update cached data
            allDaysPlaceInfo[dayIndex] = [...currentPlaceInfo];

            // Create new layer group for this day
            const layerGroup = L.layerGroup();

            currentPlaceInfo.forEach((p, i) => {
                p.num = i + 1;
                try {
                    const icon = L.divIcon({
                        html: `<div class="nm-pin" style="background:${color};animation-delay:${(p.num-1)*0.06}s"><span>${p.num}</span></div>`,
                        iconSize: [36, 36], iconAnchor: [18, 36],
                        className: 'numbered-marker'
                    });
                    const marker = L.marker([p.lat, p.lon], {icon})
                        .bindPopup(`<b>День ${planDays[dayIndex]?.dayNum || dayIndex+1}: ${p.num}. ${p.name}</b>`);
                    marker.on('click', () => selectDay(dayIndex));
                    layerGroup.addLayer(marker);
                } catch(e) {}
            });

            currentRouteData = null;
            allDaysRouteData[dayIndex] = null;

            if (currentPlaceInfo.length >= 2) {
                try {
                    const routePoints = currentPlaceInfo.map(p => ({lat: p.lat, lon: p.lon}));
                    const resp = await fetch('/api/route', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({points: routePoints, profile: 'foot'})
                    });
                    if (resp.ok) {
                        const rd = await resp.json();
                        if (rd.success && rd.geometry?.coordinates) {
                            currentRouteData = rd;
                            currentRouteData.distance_km = Math.round(rd.distance / 100) / 10;
                            currentRouteData.duration_min = Math.max(1, Math.round(rd.duration / 60));
                            allDaysRouteData[dayIndex] = currentRouteData;
                            const routeCoords = rd.geometry.coordinates.map(c => [c[1], c[0]]);
                            const polyline = L.polyline(routeCoords, {
                                color: color, weight: 6, opacity: 0.9,
                                lineCap: 'round', lineJoin: 'round'
                            });
                            polyline.on('click', () => selectDay(dayIndex));
                            layerGroup.addLayer(polyline);
                        }
                    }
                } catch(e) {}
            }

            layerGroup.addTo(leafletMap);
            allDaysMapLayers[dayIndex] = layerGroup;

            // Highlight this day, dim others
            highlightDayOnMap(dayIndex);

            if (currentPlaceInfo.length) {
                try {
                    const coords = currentPlaceInfo.map(p => [p.lat, p.lon]);
                    leafletMap.fitBounds(L.latLngBounds(coords), {padding: [50, 50]});
                } catch (e) {}
            }

            showPlacesInfo(currentPlaceInfo, dayIndex, currentRouteData);
        }

        async function addCustomPlacePrompt() {
            if (!planDays.length) return;
            const dayIndex = currentDayIndex || 0;
            const placeName = prompt('Добавить место в текущий день (название или адрес):');
            if (!placeName || !placeName.trim()) return;

            const normalized = placeName.trim();
            const already = currentPlaceInfo.some(p => (p.name || '').toLowerCase() === normalized.toLowerCase());
            if (already) {
                alert('Это место уже есть в маршруте этого дня.');
                return;
            }

            try {
                const geoBody = {place: normalized, destination: tripData.destination || ''};
                if (destCoords) { geoBody.destLat = destCoords.lat; geoBody.destLon = destCoords.lon; }
                const geoResp = await fetch('/api/geocode', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(geoBody)
                });
                const geoData = await geoResp.json();
                if (!geoData.success || !geoData.lat || !geoData.lon) {
                    alert('Не удалось найти координаты этого места. Попробуйте уточнить название.');
                    return;
                }

                currentPlaceInfo.push({
                    num: currentPlaceInfo.length + 1,
                    name: normalized,
                    lat: geoData.lat,
                    lon: geoData.lon
                });

                if (planDays[dayIndex]) {
                    const lines = planDays[dayIndex].content.split('\n');
                    const nextNum = currentPlaceInfo.length;
                    lines.push(`${nextNum}. ${normalized}`);
                    lines.push('Описание: Добавлено вручную.');
                    lines.push('Цена: бесплатно');
                    planDays[dayIndex].content = lines.join('\n');
                }

                await redrawMapFromCurrentPlaces(dayIndex);
            } catch (e) {
                alert('Ошибка при добавлении места');
            }
        }

        // ===== DELETE PLACE =====
        function deletePlace(dayIndex, placeIdx, btnEl) {
            const place = currentPlaceInfo[placeIdx];
            if (!place) return;

            // Two-tap confirm: first tap shows confirm state, second tap deletes
            if (!btnEl.classList.contains('confirm')) {
                btnEl.classList.add('confirm');
                btnEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg> Удалить?';
                // Auto-cancel after 3 seconds
                setTimeout(() => {
                    if (btnEl.classList.contains('confirm')) {
                        btnEl.classList.remove('confirm');
                        btnEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
                    }
                }, 3000);
                return;
            }

            // Actually delete
            const placeName = place.name;
            currentPlaceInfo.splice(placeIdx, 1);

            // Remove from plan text
            if (planDays[dayIndex]) {
                const lines = planDays[dayIndex].content.split('\n');
                const shortName = placeName.substring(0, 15).toLowerCase();
                let startLine = -1;
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].toLowerCase().includes(shortName)) {
                        // Find the numbered line above (or this line)
                        startLine = i;
                        if (i > 0 && /^\d+\./.test(lines[i-1].trim())) startLine = i - 1;
                        break;
                    }
                }
                if (startLine >= 0) {
                    // Remove lines until next numbered item or section header
                    let endLine = startLine + 1;
                    while (endLine < lines.length) {
                        const t = lines[endLine].trim();
                        if (/^\d+\./.test(t) || /^[🌅☀️🌙]/.test(t) || /^💰|^🍽|^🚇|^🎟|^🛍|^🏨|^📱|^💳|^ИТОГО/u.test(t)) break;
                        if (t === '' && endLine > startLine + 2) break;
                        endLine++;
                    }
                    lines.splice(startLine, endLine - startLine);
                    planDays[dayIndex].content = lines.join('\n');
                }
            }

            redrawMapFromCurrentPlaces(dayIndex);
            writePlacesBack(dayIndex, currentPlaceInfo);
        }

        // ===== SWAP PLACE =====
        async function swapPlace(dayIndex, placeIdx, btnEl) {
            const place = currentPlaceInfo[placeIdx];
            if (!place) return;
            btnEl.classList.add('loading');
            btnEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Ищем...';
            const otherPlaces = currentPlaceInfo.map(p => p.name).filter((_, i) => i !== placeIdx);
            try {
                const resp = await fetch('/api/swap-place', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        place: place.name,
                        destination: tripData.destination || '',
                        tripTypes: tripData.tripTypes || [tripData.tripType || 'Популярные места'],
                        otherPlaces: otherPlaces,
                        currencyCode: tripData.currencyCode || 'RUB'
                    })
                });
                const data = await resp.json();
                if (data.success && data.newPlace) {
                    // Update place name in placeInfo
                    const oldName = place.name;
                    place.name = data.newPlace;
                    if (data.lat != null && data.lon != null) {
                        place.lat = data.lat;
                        place.lon = data.lon;
                    }
                    place.kind = data.kind || place.kind;
                    place.description = data.description || place.description;
                    // Update text in planDays content
                    if (planDays[dayIndex]) {
                        planDays[dayIndex].content = planDays[dayIndex].content.replace(
                            new RegExp(oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
                            data.newPlace
                        );
                        // Also replace description if provided
                        if (data.description) {
                            // Find the line with old name and replace the whole entry
                            const lines = planDays[dayIndex].content.split('\n');
                            for (let i = 0; i < lines.length; i++) {
                                if (lines[i].includes(data.newPlace)) {
                                    // Found it, check if next line is description
                                    if (i + 1 < lines.length && !lines[i+1].match(/^\d+\./)) {
                                        lines[i+1] = data.description;
                                    }
                                    break;
                                }
                            }
                            planDays[dayIndex].content = lines.join('\n');
                        }
                        // dayText kept in sync (hidden but used as data fallback)
                        document.getElementById('dayText').innerHTML = formatDayContent(planDays[dayIndex].content);
                    }
                    // Re-geocode the new place and update map only if server did not send coords
                    if (place.lat == null || place.lon == null) {
                    try {
                        const geoBody = {place: data.newPlace, destination: tripData.destination || ''};
                        if (destCoords) { geoBody.destLat = destCoords.lat; geoBody.destLon = destCoords.lon; }
                        const geoResp = await fetch('/api/geocode', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify(geoBody)
                        });
                        const geoData = await geoResp.json();
                        if (geoData.success) {
                            place.lat = geoData.lat;
                            place.lon = geoData.lon;
                        }
                    } catch(e) {}
                    }
                    writePlacesBack(dayIndex, currentPlaceInfo);
                    await redrawMapFromCurrentPlaces(dayIndex);
                    selectDay(dayIndex);
                } else {
                    btnEl.innerHTML = '❌ Не удалось';
                    setTimeout(() => { btnEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>'; btnEl.classList.remove('loading'); }, 2000);
                }
            } catch(e) {
                console.error('Swap error:', e);
                btnEl.innerHTML = '❌ Ошибка';
                setTimeout(() => { btnEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>'; btnEl.classList.remove('loading'); }, 2000);
            }
        }

        // ===== MOVE PLACE BETWEEN DAYS =====
        function buildMoveDayDropdown(currentDayIdx, placeIdx) {
            let html = '<div class="move-day-dropdown"><div class="move-day-title">Переместить в:</div>';
            for (let i = 0; i < planDays.length; i++) {
                if (i === currentDayIdx) continue;
                html += `<div class="move-day-option" role="button" tabindex="0" onclick="event.stopPropagation(); movePlaceToDay(${currentDayIdx}, ${placeIdx}, ${i})">День ${planDays[i].dayNum}</div>`;
            }
            html += '</div>';
            return html;
        }

        function toggleMoveDayDropdown(btn, dayIdx, placeIdx) {
            const evt = window.event;
            if (evt) evt.stopPropagation();
            const dropdown = btn.querySelector('.move-day-dropdown');
            if (!dropdown) return;
            // Close all other dropdowns
            document.querySelectorAll('.move-day-dropdown.show').forEach(d => {
                if (d !== dropdown) d.classList.remove('show');
            });
            dropdown.classList.toggle('show');
            // Close on outside click
            const closer = (e) => {
                if (!btn.contains(e.target)) {
                    dropdown.classList.remove('show');
                    document.removeEventListener('click', closer);
                }
            };
            setTimeout(() => document.addEventListener('click', closer), 0);
        }

        async function movePlaceToDay(fromDayIdx, placeIdx, toDayIdx) {
            if (fromDayIdx === toDayIdx) return;
            const place = currentPlaceInfo[placeIdx];
            if (!place) return;

            // Нельзя переносить место, если оно единственное в дне — день не должен опустеть
            if (currentPlaceInfo.length <= 1) {
                showMoveToast('Нельзя перенести — это единственное место в дне');
                return;
            }

            // Remove from current day's placeInfo
            currentPlaceInfo.splice(placeIdx, 1);
            writePlacesBack(fromDayIdx, currentPlaceInfo);
            if (planDays[toDayIdx]) {
                const destPlaces = Array.isArray(planDays[toDayIdx].jsonPlaces)
                    ? planDays[toDayIdx].jsonPlaces.slice()
                    : (allDaysPlaceInfo[toDayIdx] || []).slice();
                destPlaces.push({
                    name: place.name,
                    lat: place.lat,
                    lon: place.lon,
                    kind: place.kind,
                    address: place.address,
                    description: 'Перемещено из другого дня.',
                });
                writePlacesBack(toDayIdx, destPlaces);
            }

            // Remove from plan text of source day
            if (planDays[fromDayIdx]) {
                const lines = planDays[fromDayIdx].content.split('\n');
                const shortName = place.name.substring(0, 15).toLowerCase();
                let startLine = -1;
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].toLowerCase().includes(shortName)) {
                        startLine = i;
                        if (i > 0 && /^\d+\./.test(lines[i-1].trim())) startLine = i - 1;
                        break;
                    }
                }
                if (startLine >= 0) {
                    let endLine = startLine + 1;
                    while (endLine < lines.length) {
                        const t = lines[endLine].trim();
                        if (/^\d+\./.test(t) || /^[🌅☀️🌙]/.test(t) || /^💰|^🍽|^🚇|^🎟|^🛍|^🏨|^📱|^💳|^ИТОГО/u.test(t)) break;
                        if (t === '' && endLine > startLine + 2) break;
                        endLine++;
                    }
                    lines.splice(startLine, endLine - startLine);
                    planDays[fromDayIdx].content = lines.join('\n');
                }
            }

            // Add to target day's plan text
            if (planDays[toDayIdx]) {
                const lines = planDays[toDayIdx].content.split('\n');
                const nextNum = (lines.filter(l => /^\d+\./.test(l.trim())).length) + 1;
                lines.push('');
                lines.push(`${nextNum}. ${place.name}`);
                lines.push('Перемещено из другого дня.');
                planDays[toDayIdx].content = lines.join('\n');
            }

            // Redraw current day
            await redrawMapFromCurrentPlaces(fromDayIdx);

            // Show toast
            const dayNum = planDays[toDayIdx]?.dayNum || (toDayIdx + 1);
            showMoveToast(`Перемещено в День ${dayNum}`);
        }

        function showMoveToast(msg) {
            let toast = document.getElementById('moveToast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'moveToast';
                toast.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:#1C1719;color:#fff;padding:10px 20px;border-radius:12px;font-size:13px;font-weight:600;z-index:9000;opacity:0;transition:opacity 0.3s;pointer-events:none;box-shadow:0 4px 15px rgba(0,0,0,0.2);';
                document.body.appendChild(toast);
            }
            toast.textContent = msg;
            toast.style.opacity = '1';
            setTimeout(() => { toast.style.opacity = '0'; }, 2000);
        }

        // ===== EXAMPLE ROUTES =====
        const exampleRoutes = [
            {
                id: 'paris-3d',
                demo: true,
                dayTitles: ['Сердце Парижа', 'Лувр, острова и Монмартр', 'Версаль и Марэ'],
                coords: { lat: 48.8566, lon: 2.3522 },
                title: 'Классический Париж',
                city: 'Париж',
                country: 'Франция',
                days: 3,
                tags: ['Культура', 'Романтика', 'Гастрономия'],
                img: '/img/destinations/paris.jpg',
                destination: 'Париж, Франция',
                tripTypes: ['Популярные места', 'Гастрономия'],
                budget: 'Средний',
                planText: `День 1 — Сердце Парижа

🌅 УТРО
1. Эйфелева башня (Champ de Mars, 5 Avenue Anatole France)
   Подъём на второй уровень. Лучшее время — к открытию, чтобы избежать очередей.
   Время: 09:00-11:00. Цена: ~17€

☀️ ДЕНЬ
2. Трокадеро (Place du Trocadéro)
   Лучший вид на Эйфелеву башню. Фонтаны и сады.
   Время: 11:30-12:00. Бесплатно

3. Река Сена — прогулка по набережной
   Прогулка от Трокадеро до моста Александра III.
   Время: 12:00-13:00. Бесплатно

4. Musée d'Orsay (1 Rue de la Légion d'Honneur)
   Импрессионисты: Моне, Ренуар, Дега. Здание — бывший вокзал.
   Время: 14:00-16:30. Цена: ~16€

🌙 ВЕЧЕР
5. Сен-Жермен-де-Пре (Boulevard Saint-Germain)
   Исторический район: кафе, книжные, атмосфера Парижа. Ужин в местном бистро.
   Время: 18:00-21:00. Ужин: ~25-40€

🍽 Еда: ~50€
🚇 Транспорт: ~8€ (carnet/Navigo)
🎟 Билеты и входы: ~33€
💳 ИТОГО: ~91€

День 2 — Лувр, Острова и Монмартр

🌅 УТРО
1. Лувр (Rue de Rivoli, 75001 Paris)
   Мона Лиза, Венера Милосская, Ника Самофракийская. Покупайте билеты онлайн.
   Время: 09:00-12:30. Цена: ~22€

☀️ ДЕНЬ
2. Île de la Cité — Нотр-Дам и Сент-Шапель (10 Boulevard du Palais)
   Нотр-Дам (реконструкция, вид снаружи) + Сент-Шапель с витражами XIII века.
   Время: 13:00-15:00. Цена: ~11.5€

3. Латинский квартал (Rue de la Huchette)
   Средневековые улочки, книжный Shakespeare and Company, фалафель на Rue Mouffetard.
   Время: 15:00-16:30. Перекус: ~8€

🌙 ВЕЧЕР
4. Монмартр и Сакре-Кёр (35 Rue du Chevalier de la Barre)
   Подъём к базилике, вид на весь Париж. Площадь художников Place du Tertre.
   Время: 17:30-20:00. Бесплатно

5. Ужин на Монмартре
   Уютные рестораны на Rue Lepic или Rue des Abbesses.
   Время: 20:00-22:00. Ужин: ~30-45€

🍽 Еда: ~60€
🚇 Транспорт: ~8€
🎟 Билеты и входы: ~33.5€
💳 ИТОГО: ~101.5€

День 3 — Версаль и Марэ

🌅 УТРО
1. Версаль (Place d'Armes, 78000 Versailles)
   Дворец, Зеркальный зал, сады. Поезд RER C (~40 мин). Приезжайте к открытию!
   Время: 09:00-13:00. Цена: ~21€ + RER ~7€ туда-обратно

☀️ ДЕНЬ
2. Le Marais (Rue des Francs-Bourgeois)
   Модный район: бутики, галереи, лучший фалафель Парижа на Rue des Rosiers.
   Время: 14:30-17:00. Перекус: ~10€

3. Place des Vosges
   Старейшая площадь Парижа. Красные фасады, аркады, дом Виктора Гюго.
   Время: 17:00-17:30. Бесплатно

🌙 ВЕЧЕР
4. Centre Pompidou (Place Georges-Pompidou)
   Современное искусство. Здание-наизнанку. Бесплатный вид с крыши.
   Время: 18:00-19:30. Цена: ~15€

5. Круиз по Сене (Bateaux Mouches, Pont de l'Alma)
   Вечерний круиз: все памятники с воды в подсветке. Идеальное завершение!
   Время: 20:30-21:30. Цена: ~15€

🍽 Еда: ~45€
🚇 Транспорт: ~15€
🎟 Билеты и входы: ~51€
💳 ИТОГО: ~111€`,
                places: {
                    0: [{name:'Эйфелева башня',lat:48.8584,lon:2.2945,desc:'Символ Парижа высотой 330 м, построенная к Всемирной выставке 1889 года. Смотровые площадки на трёх уровнях, вечером — световое мерцание каждый час.'},{name:'Трокадеро',lat:48.8627,lon:2.2878,desc:'Лучшая смотровая площадка на Эйфелеву башню: эспланада с фонтанами Варшавы и садами напротив Сены.'},{name:'Набережная Сены',lat:48.8620,lon:2.3130,desc:'Прогулка вдоль реки мимо букинистов, мостов и исторических фасадов — набережные входят в список ЮНЕСКО.'},{name:"Musée d'Orsay",lat:48.8600,lon:2.3266,desc:'Музей импрессионистов в здании бывшего вокзала: Моне, Ренуар, Ван Гог, Дега и знаменитые часы-окно.'},{name:'Сен-Жермен-де-Пре',lat:48.8540,lon:2.3335,desc:'Легендарный квартал интеллектуалов: кафе «Флор» и «Дё Маго», старейшая церковь Парижа и букинистические лавки.'}],
                    1: [{name:'Лувр',lat:48.8606,lon:2.3376,desc:'Крупнейший музей мира: «Мона Лиза», «Венера Милосская», стеклянная пирамида и 35 000 экспонатов в бывшем королевском дворце.'},{name:'Сент-Шапель',lat:48.8554,lon:2.3451,desc:'Готическая капелла XIII века с 15 гигантскими витражами — один из самых сияющих интерьеров Европы.'},{name:'Латинский квартал',lat:48.8510,lon:2.3471,desc:'Студенческий квартал вокруг Сорбонны: узкие улочки, книжный «Шекспир и компания», недорогие бистро.'},{name:'Сакре-Кёр',lat:48.8867,lon:2.3431,desc:'Белоснежная базилика на вершине Монмартра с панорамой всего Парижа. Лучше всего — на закате.'},{name:'Монмартр',lat:48.8847,lon:2.3406,desc:'Холм художников: площадь Тертр с портретистами, виноградник, мельница Галетт и атмосфера богемного Парижа.'}],
                    2: [{name:'Версаль',lat:48.8049,lon:2.1204,desc:'Резиденция Людовика XIV: Зеркальная галерея, королевские апартаменты и парк с фонтанами на 800 гектаров.'},{name:'Le Marais',lat:48.8570,lon:2.3623,desc:'Средневековый квартал с особняками XVII века, модными бутиками, еврейским кварталом и лучшим фалафелем города.'},{name:'Place des Vosges',lat:48.8554,lon:2.3656,desc:'Старейшая площадь Парижа: идеальный квадрат из кирпичных аркад, где жил Виктор Гюго.'},{name:'Centre Pompidou',lat:48.8607,lon:2.3525,desc:'Центр современного искусства с вывернутыми наружу коммуникациями и видом на крыши Парижа с верхнего этажа.'},{name:'Bateaux Mouches',lat:48.8642,lon:2.3049,desc:'Круиз по Сене на прогулочном кораблике: Лувр, Нотр-Дам и Эйфелева башня с воды, особенно красиво вечером.'}]
                }
            },
            {
                id: 'istanbul-4d',
                title: 'Стамбул — Восток и Запад',
                city: 'Стамбул',
                country: 'Турция',
                days: 4,
                tags: ['История', 'Гастрономия', 'Шопинг'],
                img: '/img/destinations/istanbul.jpg',
                destination: 'Стамбул, Турция',
                tripTypes: ['Популярные места', 'История и архитектура'],
                budget: 'Средний',
                planText: `День 1 — Султанахмет: сердце империй

🌅 УТРО
1. Айя-София (Sultan Ahmet, Ayasofya Meydanı)
   Главный символ Стамбула. Собор→мечеть→музей→мечеть. Мозаики Византии.
   Время: 09:00-11:00. Бесплатно (мечеть)

☀️ ДЕНЬ
2. Голубая мечеть (Sultan Ahmet Camii)
   6 минаретов, 20 000 голубых изникских плиток. Напротив Айя-Софии.
   Время: 11:30-12:30. Бесплатно

3. Цистерна Базилика (Yerebatan Sarnıcı, Alemdar Mh.)
   Подземное водохранилище VI века. Колонны с головами Медузы.
   Время: 13:00-14:00. Цена: ~200₺

4. Гранд-Базар (Kapalıçarşı, Beyazıt)
   4000+ лавок. Специи, ковры, лампы, керамика. Торгуйтесь!
   Время: 14:30-17:00. Покупки: по желанию

🌙 ВЕЧЕР
5. Ужин в Sultanahmet
   Кебабы, мезе, бакалава. Вид на подсветку мечетей.
   Время: 19:00-21:00. Ужин: ~200-400₺

🍽 Еда: ~500₺
🚇 Транспорт: ~100₺
🎟 Билеты и входы: ~200₺
💳 ИТОГО: ~800₺

День 2 — Дворцы и Босфор

🌅 УТРО
1. Дворец Топкапы (Topkapı Sarayı, Cankurtaran)
   Резиденция османских султанов. Гарем, сокровищница, вид на Босфор.
   Время: 09:00-12:00. Цена: ~750₺ (дворец + гарем)

☀️ ДЕНЬ
2. Египетский базар (Mısır Çarşısı, Eminönü)
   Специи, турецкие сладости, сухофрукты, чай. Ароматный рай.
   Время: 12:30-14:00. Перекус: ~100₺

3. Круиз по Босфору (Eminönü iskelesi)
   Паромная линия Eminönü→Anadolu Kavağı. Виды на дворцы, мечети, крепости.
   Время: 14:30-17:30. Цена: ~150₺

🌙 ВЕЧЕР
4. Район Кадыкёй (Kadıköy, азиатская сторона)
   Рыбный рынок, бары, стрит-арт. Настоящий Стамбул без туристов.
   Время: 18:00-21:00. Ужин: ~250-400₺

🍽 Еда: ~500₺
🚇 Транспорт: ~200₺
🎟 Билеты и входы: ~900₺
💳 ИТОГО: ~1600₺

День 3 — Бейоглу и современный Стамбул

🌅 УТРО
1. Галатская башня (Galata Kulesi, Beyoğlu)
   Панорама 360° на весь город. Лучше утром — меньше очередей.
   Время: 09:00-10:30. Цена: ~650₺

☀️ ДЕНЬ
2. Истикляль (İstiklal Caddesi)
   Главная пешеходная улица: магазины, кафе, красный трамвай.
   Время: 11:00-13:00. Бесплатно

3. Музей современного искусства Istanbul Modern (Kılıçali Paşa, Tophane)
   Турецкое современное искусство. Здание от Ренцо Пиано.
   Время: 14:00-16:00. Цена: ~120₺

🌙 ВЕЧЕР
4. Район Каракёй (Karaköy)
   Трендовые кафе, бутики, галереи. Ужин с видом на Босфор.
   Время: 17:00-21:00. Ужин: ~300-500₺

🍽 Еда: ~500₺
🚇 Транспорт: ~100₺
🎟 Билеты и входы: ~770₺
💳 ИТОГО: ~1370₺

День 4 — Принцевы острова и финал

🌅 УТРО
1. Принцевы острова — Бююкада (Büyükada)
   Паром от Кабаташ. Без машин, велосипеды, фаэтоны, сосновый лес.
   Время: 08:30-14:00. Паром: ~100₺ туда-обратно

☀️ ДЕНЬ
2. Мечеть Сулеймание (Süleymaniye Camii, Fatih)
   Шедевр архитектора Синана. Спокойнее Голубой мечети. Сад с видом.
   Время: 15:00-16:30. Бесплатно

🌙 ВЕЧЕР
3. Балат и Фенер (Balat, Fatih)
   Цветные дома, греческая архитектура, Instagram-локации. Чай с видом.
   Время: 17:00-20:00. Перекус: ~150₺

🍽 Еда: ~400₺
🚇 Транспорт: ~200₺
🎟 Билеты и входы: ~100₺
💳 ИТОГО: ~700₺`,
                places: {
                    0: [{name:'Айя-София',lat:41.0086,lon:28.9802},{name:'Голубая мечеть',lat:41.0054,lon:28.9768},{name:'Цистерна Базилика',lat:41.0084,lon:28.9779},{name:'Гранд-Базар',lat:41.0108,lon:28.9680}],
                    1: [{name:'Дворец Топкапы',lat:41.0115,lon:28.9833},{name:'Египетский базар',lat:41.0166,lon:28.9706},{name:'Босфор',lat:41.0500,lon:29.0350},{name:'Кадыкёй',lat:40.9900,lon:29.0250}],
                    2: [{name:'Галатская башня',lat:41.0256,lon:28.9741},{name:'Истикляль',lat:41.0325,lon:28.9785},{name:'Istanbul Modern',lat:41.0262,lon:28.9836},{name:'Каракёй',lat:41.0224,lon:28.9774}],
                    3: [{name:'Бююкада',lat:40.8619,lon:29.1262},{name:'Мечеть Сулеймание',lat:41.0162,lon:28.9641},{name:'Балат',lat:41.0295,lon:28.9487}]
                }
            },
            {
                id: 'tokyo-3d',
                title: 'Токио за 3 дня',
                city: 'Токио',
                country: 'Япония',
                days: 3,
                tags: ['Культура', 'Гастрономия', 'Технологии'],
                img: '/img/destinations/tokyo.jpg',
                destination: 'Токио, Япония',
                tripTypes: ['Популярные места', 'Гастрономия'],
                budget: 'Средний',
                planText: `День 1 — Традиционный Токио

🌅 УТРО
1. Рыбный рынок Цукидзи (Tsukiji Outer Market)
   Свежайшие суши на завтрак. Тамагояки, унаги, тунец.
   Время: 08:00-10:00. Завтрак: ~2000¥

☀️ ДЕНЬ
2. Храм Сэнсо-дзи (Sensō-ji, Asakusa)
   Древнейший храм Токио. Ворота Каминаримон, улица Накамисэ.
   Время: 10:30-12:30. Бесплатно

3. Tokyo Skytree (1 Chome-1-2 Oshiage, Sumida)
   Самая высокая телебашня мира (634м). Панорама всего Токио.
   Время: 13:00-14:30. Цена: ~2100¥

4. Район Акихабара (Akihabara Electric Town)
   Мекка аниме, манги, электроники. Мэйд-кафе, аркадные автоматы.
   Время: 15:00-17:30. Покупки: по желанию

🌙 ВЕЧЕР
5. Район Синдзюку (Shinjuku)
   Неоновые улицы, Golden Gai (крошечные бары), Omoide Yokocho (якитори).
   Время: 18:30-22:00. Ужин: ~3000¥

🍽 Еда: ~6000¥
🚇 Транспорт: ~1500¥ (Suica/Pasmo)
🎟 Билеты и входы: ~2100¥
💳 ИТОГО: ~9600¥

День 2 — Современный Токио

🌅 УТРО
1. Храм Мэйдзи (Meiji Jingū, Shibuya)
   Оазис тишины. Тории из кипариса, лес в центре города.
   Время: 09:00-10:30. Бесплатно

☀️ ДЕНЬ
2. Харадзюку (Harajuku, Takeshita Street)
   Молодёжная мода, крепы, винтажные магазины.
   Время: 11:00-13:00. Перекус: ~1000¥

3. Район Сибуя (Shibuya Crossing)
   Знаменитый перекрёсток. Статуя Хатико. Shibuya Sky — смотровая.
   Время: 13:30-15:30. Shibuya Sky: ~2000¥

4. Район Одайба (Odaiba)
   Искусственный остров: teamLab Borderless, Gundam, вид на Rainbow Bridge.
   Время: 16:00-19:00. teamLab: ~3800¥

🌙 ВЕЧЕР
5. Район Роппонги (Roppongi Hills)
   Токийская башня ночью, ужин с видом, Mori Art Museum.
   Время: 19:30-22:00. Ужин: ~3000¥

🍽 Еда: ~5000¥
🚇 Транспорт: ~1500¥
🎟 Билеты и входы: ~5800¥
💳 ИТОГО: ~12300¥

День 3 — Императорский Токио и сувениры

🌅 УТРО
1. Императорский дворец (Imperial Palace East Gardens, Chiyoda)
   Сады, рвы, руины замка Эдо. Бесплатно и спокойно.
   Время: 09:00-11:00. Бесплатно

☀️ ДЕНЬ
2. Район Гиндза (Ginza)
   Люксовый шопинг, флагманские магазины, галереи.
   Время: 11:30-14:00. Обед: ~2000¥

3. Район Янака (Yanaka)
   Старый Токио: деревянные дома, храмы, кладбище с сакурой.
   Время: 14:30-16:30. Бесплатно

🌙 ВЕЧЕР
4. Токийская телебашня (Tokyo Tower, Minato)
   Классический вид. Оранжевая подсветка ночью. 
   Время: 17:00-18:30. Цена: ~1200¥

5. Район Эбису (Ebisu, Yebisu Garden Place)
   Спокойный ужин. Музей пива Yebisu. Красивая аллея.
   Время: 19:00-21:30. Ужин: ~3500¥

🍽 Еда: ~6500¥
🚇 Транспорт: ~1200¥
🎟 Билеты и входы: ~1200¥
💳 ИТОГО: ~8900¥`,
                places: {
                    0: [{name:'Рынок Цукидзи',lat:35.6654,lon:139.7707},{name:'Сэнсо-дзи',lat:35.7148,lon:139.7967},{name:'Tokyo Skytree',lat:35.7101,lon:139.8107},{name:'Акихабара',lat:35.6984,lon:139.7731},{name:'Синдзюку',lat:35.6938,lon:139.7034}],
                    1: [{name:'Храм Мэйдзи',lat:35.6764,lon:139.6993},{name:'Харадзюку',lat:35.6702,lon:139.7027},{name:'Сибуя',lat:35.6595,lon:139.7004},{name:'Одайба',lat:35.6267,lon:139.7762},{name:'Роппонги',lat:35.6603,lon:139.7292}],
                    2: [{name:'Императорский дворец',lat:35.6852,lon:139.7528},{name:'Гиндза',lat:35.6717,lon:139.7649},{name:'Янака',lat:35.7246,lon:139.7677},{name:'Токийская телебашня',lat:35.6586,lon:139.7454},{name:'Эбису',lat:35.6468,lon:139.7100}]
                }
            },
            {
                id: 'altai-3d',
                region: 'russia',
                title: 'Алтай — горы и Чуйский тракт',
                city: 'Алтай',
                country: 'Россия',
                days: 3,
                tags: ['Природа', 'Горы'],
                img: '/img/destinations/altai.jpg',
                destination: 'Алтай, Россия',
                tripTypes: ['Природа'],
                budget: 'Средний',
                planText: 'День 1 — Горно-Алтайск и долина Катуни\n\n1. НАЦИОНАЛЬНЫЙ МУЗЕЙ АЛТАЯ\n2. НАБЕРЕЖНАЯ КАТУНИ\n\nДень 2 — Чемал\n\n1. ОСТРОВ ПАТМОС\n2. ЧЕМАЛЬСКАЯ ГЭС',
                places: {}
            },
            {
                id: 'suzdal-3d',
                region: 'russia',
                demo: true,
                dayTitles: ['Кремль и Торговая площадь', 'Монастыри Суздаля', 'Кидекша и окрестности'],
                title: 'Золотое кольцо: Суздаль',
                city: 'Суздаль',
                country: 'Россия',
                days: 3,
                tags: ['История', 'Храмы'],
                img: '/img/destinations/suzdal.jpg',
                destination: 'Суздаль, Россия',
                tripTypes: ['История и архитектура'],
                budget: 'Средний',
                coords: { lat: 56.4167, lon: 40.4458 },
                planText: `День 1 — Кремль и Торговая площадь

🌅 УТРО
1. Суздальский кремль и Рождественский собор (Кремлёвская ул.)
   Древнейшая часть города: валы, собор с синими куполами, Никольская церковь.
   Время: 09:00-11:00. Цена: ~300₽

☀️ ДЕНЬ
2. Торговая площадь и Торговые ряды
   Сувениры, медовуха, местные фермерские продукты. Обед в одной из харчевен.
   Время: 11:30-14:00. Обед: ~700₽

3. Музей деревянного зодчества (Пушкарская ул.)
   Крестьянские избы, ветряные мельницы и церкви без единого гвоздя под открытым небом.
   Время: 14:30-16:30. Цена: ~400₽

🌙 ВЕЧЕР
4. Набережная Каменки у Кремлёвского вала
   Золотой час: вид на кремль и монастыри с противоположного берега.
   Время: 17:00-19:00. Бесплатно

🍽 Еда: ~1500₽
🎟 Билеты и входы: ~700₽
💳 ИТОГО: ~2200₽

День 2 — Монастыри Суздаля

🌅 УТРО
1. Спасо-Евфимиев монастырь (ул. Ленина, 135к8)
   Крепость-монастырь XVI века. В 12:00 и 15:00 — звонница, звонят колокола.
   Время: 10:00-12:30. Цена: ~500₽

☀️ ДЕНЬ
2. Ризоположенский монастырь (ул. Ленина, 79)
   Строгий и тихий, редко бывает многолюдно. Колокольня и святые ворота.
   Время: 13:00-14:00. Цена: ~150₽

3. Покровский монастырь (Покровская ул., 76)
   Знаменитые «покровские» сказки и белокаменный ансамбль у реки.
   Время: 14:30-16:00. Цена: ~200₽

🌙 ВЕЧЕР
4. Ул. Ленина — прогулка и ужин
   Главная «туристическая» улица: медовуха, пряники, ужин в трапезной.
   Время: 17:00-20:00. Ужин: ~900₽

🍽 Еда: ~1700₽
🎟 Билеты и входы: ~850₽
💳 ИТОГО: ~2550₽

День 3 — Кидекша и окрестности

🌅 УТРО
1. Кидекша: церковь Бориса и Глеба (с. Кидекша)
   Храм 1152 года у впадения Нерли в Каменку — один из первых белокаменных храмов Руси.
   Время: 09:30-11:00. Цена: ~150₽

☀️ ДЕНЬ
2. Конюшенный двор и смотровая у валов (ул. Ленина)
   Аренда велосипедов или кареты, фото-точки на валу кремля.
   Время: 11:30-13:30. Цена: ~300₽

3. Дегустация медовухи у Торговых рядов
   10 сортов медовухи: от классической до хреновухи. Сувениры домой.
   Время: 14:00-15:00. Цена: ~400₽

🌙 ВЕЧЕР
4. Прощальный вечер у Каменки
   Последняя прогулка по набережной, ужин с видом на монастыри.
   Время: 17:00-19:30. Ужин: ~900₽

🍽 Еда: ~1600₽
🎟 Билеты и входы: ~850₽
💳 ИТОГО: ~2450₽`,
                places: {
                    0: [{name:'Суздальский кремль',lat:56.4167,lon:40.4458,desc:'Древнейшее ядро города X века: Рождественский собор с золотыми вратами, архиерейские палаты и Никольская деревянная церковь.'},{name:'Торговые ряды',lat:56.4179,lon:40.4523,desc:'Главная торговая площадь Суздаля: галереи начала XIX века, лавки с медовухой, сувенирами и местными угощениями.'},{name:'Музей деревянного зодчества',lat:56.4095,lon:40.4408,desc:'Под открытым небом собраны избы, ветряные мельницы и церкви XVIII–XIX веков, перевезённые из деревень Владимирской области.'},{name:'Набережная Каменки',lat:56.4155,lon:40.4480,desc:'Тихая прогулка вдоль реки с видом на белокаменные монастыри и купола — лучшие фототочки города.'}],
                    1: [{name:'Спасо-Евфимиев монастырь',lat:56.4323,lon:40.4397,desc:'Крепость-монастырь XIV века с мощными стенами и башнями. Каждый час над обителью разносится перезвон колоколов.'},{name:'Ризоположенский монастырь',lat:56.4286,lon:40.4461,desc:'Один из старейших монастырей России, знаменит ажурной шатровой колокольней — самой высокой в Суздале.'},{name:'Покровский монастырь',lat:56.4219,lon:40.4328,desc:'Тихий женский монастырь, куда ссылали цариц и княгинь. Уютное подворье и домашняя выпечка у ворот.'},{name:'Улица Ленина',lat:56.4202,lon:40.4490,desc:'Главная улица города: купеческие особняки, чайные, ремесленные мастерские и вид на Каменку.'}],
                    2: [{name:'Церковь Бориса и Глеба, Кидекша',lat:56.4428,lon:40.5256,desc:'Храм 1152 года у слияния Каменки и Нерли — один из древнейших белокаменных храмов Северо-Восточной Руси.'},{name:'Конюшенный двор',lat:56.4188,lon:40.4556,desc:'Живой исторический комплекс: конюшни, каретный сарай, катание в повозке и фермерские продукты.'},{name:'Дегустация медовухи',lat:56.4176,lon:40.4532,desc:'Фирменный суздальский напиток: десятки сортов — от классической до хмельной, с рассказом о технологии.'},{name:'Набережная Каменки',lat:56.4155,lon:40.4480,desc:'Вечерняя прогулка по набережной: подсветка монастырей и спокойная вода — красивое завершение поездки.'}]
                }
            },
            {
                id: 'dagestan-3d',
                region: 'russia',
                title: 'Дагестан: Дербент и горы',
                city: 'Дагестан',
                country: 'Россия',
                days: 3,
                tags: ['История', 'Горы'],
                img: '/img/destinations/dagestan.jpg',
                destination: 'Дагестан, Россия',
                tripTypes: ['История и архитектура', 'Природа'],
                budget: 'Средний',
                planText: 'День 1 — Дербент\n\n1. КРЕПОСТЬ НАРЫН-КАЛА\n2. ДЖУМА-МЕЧЕТЬ\n\nДень 2 — Сулакский каньон\n\n1. СМОТРОВАЯ КАНЬОНА',
                places: {}
            },
            {
                id: 'kamchatka-3d',
                region: 'russia',
                title: 'Камчатка: вулканы и океан',
                city: 'Камчатка',
                country: 'Россия',
                days: 3,
                tags: ['Природа', 'Вулканы'],
                img: '/img/destinations/kamchatka.jpg',
                destination: 'Камчатка, Россия',
                tripTypes: ['Природа'],
                budget: 'Средний',
                planText: 'День 1 — Петропавловск-Камчатский\n\n1. МИШКА НА АВАЧЕ\n2. БУХТА МОХОРА\n\nДень 2 — Вулкан Авачинский\n\n1. ТРОПА НА ВУЛКАН',
                places: {}
            },
            {
                id: 'baikal-3d',
                region: 'russia',
                title: 'Байкал: Листвянка и Ольхон',
                city: 'Байкал',
                country: 'Россия',
                days: 3,
                tags: ['Природа', 'Озеро'],
                img: '/img/destinations/baikal.jpg',
                destination: 'Байкал, Россия',
                tripTypes: ['Природа'],
                budget: 'Средний',
                planText: 'День 1 — Листвянка\n\n1. БАЙКАЛЬСКИЙ МУЗЕЙ\n2. НАБЕРЕЖНАЯ\n\nДень 2 — Ольхон\n\n1. МЫС БУРХАН',
                places: {}
            },
            {
                id: 'kazan-3d',
                region: 'russia',
                title: 'Казань: кремль и Старо-Татарская',
                city: 'Казань',
                country: 'Россия',
                days: 3,
                tags: ['История', 'Гастрономия'],
                img: '/img/destinations/kazan.jpg',
                destination: 'Казань, Россия',
                tripTypes: ['История и архитектура', 'Гастрономия'],
                budget: 'Средний',
                planText: 'День 1 — Казанский кремль\n\n1. КУЛ-ШАРИФ\n2. БАШНЯ СЮЮМБИКЕ\n\nДень 2 — Старо-Татарская слобода\n\n1. МЕЧЕТЬ МАРДЖАНИ',
                places: {}
            }
        ];

        async function initExampleRoutes() {
            const scroll = document.getElementById('exampleRoutesScroll');
            if (!scroll) return;
            try { await initExampleRoutesUnsafe(scroll); } catch (e) { console.error('initExampleRoutes failed:', e); }
        }
        async function initExampleRoutesUnsafe(scroll) {
            let gold = window.__tbGoldRoutes || [];
            if (!gold.length) {
                try {
                    const r = await fetch('/api/gold-routes');
                    const data = await r.json();
                    gold = Array.isArray(data.routes) ? data.routes : [];
                    window.__tbGoldRoutes = gold;
                } catch (e) { gold = []; }
            }
            const goldMapped = gold
                .filter((r) => (r.region || 'world') === travelRegion)
                .map((r) => ({
                    id: r.id,
                    title: r.title,
                    city: r.city,
                    country: r.country,
                    days: r.days,
                    tags: r.tags || [],
                    img: r.img,
                    destination: `${r.city}, ${r.country}`,
                    tripTypes: r.tags,
                    budget: 'Средний',
                    region: r.region,
                }));
            const rest = exampleRoutes.filter((r) => (r.region || 'world') === travelRegion && !goldMapped.some((g) => g.city === r.city));
            const list = goldMapped.concat(rest);
            scroll.innerHTML = list.map((r) => {
                const favKey = String(r.id || r.city).toLowerCase();
                return `
                <div class="example-route-card" onclick="showRouteSheet('${r.id}')">
                    <img class="example-route-img" src="${r.img}" alt="${r.title}" loading="eager" decoding="async" onerror="this.onerror=null;this.src='/img/destinations/altai.jpg'"/>
                    <button type="button" class="example-route-heart${tbFavHas('route', favKey) ? ' is-on' : ''}" aria-label="В избранное" onclick="event.stopPropagation(); tbFavHeart(this, 'route', '${favKey}', '${String(r.title).replace(/'/g, '')}')">${tbHeartSvg()}</button>
                    <div class="example-route-body">
                        <div class="example-route-title">${r.title}</div>
                        <div class="example-route-meta">${r.days} дн · ${r.city}, ${r.country}</div>
                        <div class="example-route-tags">
                            ${(r.tags || []).map((t) => `<span class="example-route-tag">${t}</span>`).join('')}
                        </div>
                    </div>
                </div>`;
            }).join('');
        }
        function tbFavHeart(btn, kind, key, title) {
            tbToggleFav(btn, kind, key, title, {});
        }
        window.tbFavHeart = tbFavHeart;
        window.__tbDiag = () => ({
            planDays: (typeof planDays !== 'undefined' ? planDays.length : -1),
            region: (typeof travelRegion !== 'undefined' ? travelRegion : '?'),
            favs: (function(){ try { return JSON.stringify(tbFavStore()).slice(0, 120); } catch (e) { return 'ERR:' + e; } })(),
            bootError: window.__tbBootError || null,
        });
        function renderExampleRoutes() { initExampleRoutes(); }
        window.renderExampleRoutes = renderExampleRoutes;

        // Собирает planJson с координатами из this.places эталонного маршрута
        function demoPlanJsonFromRoute(route) {
            const times = [['09:00','11:00'],['11:30','13:30'],['14:30','16:30'],['17:00','19:00'],['19:30','21:30']];
            const days = [];
            const n = route.days || Object.keys(route.places || {}).length;
            for (let i = 0; i < n; i++) {
                const pts = (route.places && route.places[i]) || [];
                days.push({
                    day: i + 1,
                    district: (route.dayTitles && route.dayTitles[i]) || `День ${i + 1}`,
                    places: pts.map((p, j) => ({
                        name: p.name,
                        address: route.destination || `${route.city}, ${route.country}`,
                        timeStart: (times[j] || ['10:00','12:00'])[0],
                        timeEnd: (times[j] || ['10:00','12:00'])[1],
                        description: p.desc || '',
                        price: '',
                        lat: p.lat,
                        lon: p.lon,
                    })),
                });
            }
            return {
                destination: route.destination || `${route.city}, ${route.country}`,
                country: route.country || '',
                theme: (route.tripTypes || route.tags || [])[0] || '',
                days,
            };
        }

        async function loadExampleTrip(routeId) {
            const route = exampleRoutes.find(r => r.id === routeId) || window.__tbGoldRoutes?.find((r) => r.id === routeId);
            if (!route) return;
            closeRouteSheet();

            tripData.destination = route.destination || `${route.city}, ${route.country}`;
            tripData.country = route.country;
            tripData.city = route.city;
            tripData.daysCount = route.days;
            tripData.tripTypes = route.tripTypes || route.tags || ['Популярные места'];
            tripData.tripType = (tripData.tripTypes || [])[0];
            selectedTripTypes = [...(tripData.tripTypes || [])];
            tripData.budget = route.budget || 'Средний';
            tripData.travelers = '2';
            tripData.currencyCode = route.country === 'Россия' ? 'RUB' : 'EUR';
            const start = new Date();
            start.setDate(start.getDate() + 1);
            const end = new Date(start);
            end.setDate(end.getDate() + route.days - 1);
            tripData.dateStart = start.toISOString().slice(0, 10);
            tripData.dateEnd = end.toISOString().slice(0, 10);

            showLoadingView();

            // Эталонный демо-маршрут: всё уже на клиенте, открываем мгновенно
            if (route.demo && route.places && Object.keys(route.places).length) {
                const demoResult = {
                    success: true,
                    plan: route.planText || '',
                    planJson: demoPlanJsonFromRoute(route),
                    coords: route.coords || null,
                    access: { subscribed: true, freeDays: 99, requestedDays: route.days, visibleDays: 99, cached: false },
                    source: 'demo',
                };
                persistActiveTrip(demoResult);
                setTimeout(() => onApiComplete(demoResult), 1400);
                return;
            }

            const controller = new AbortController();
            const kill = setTimeout(() => controller.abort(), 22000);
            try {
                const response = await fetch('/api/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...tripData,
                        goldId: route.id,
                        region: route.region || travelRegion,
                        destination: tripData.destination,
                    }),
                    signal: controller.signal,
                });
                let data = await response.json().catch(() => ({ success: false }));
                if (!response.ok || !data.success || !(data.plan || data.planJson)) {
                    onApiComplete(buildClientFallback(data.error || 'HTTP'));
                    return;
                }
                persistActiveTrip(data);
                onApiComplete(data);
            } catch (error) {
                onApiComplete(buildClientFallback(error.message || error));
            } finally {
                clearTimeout(kill);
            }
        }
        window.loadExampleTrip = loadExampleTrip;
        window.showRouteSheet = showRouteSheet;
        window.closeRouteSheet = closeRouteSheet;

        // ═══ Load ALL example days on map at once (pre-defined coords) ═══
        async function loadAllExampleDaysOnMap(route) {
            const mapEl = document.getElementById('leafletMap');
            const mapSection = document.getElementById('mapSection');
            mapSection.classList.remove('hidden');

            if (typeof L === 'undefined' || !mapEl) return;

            if (!leafletMap) {
                try {
                    const firstPlace = route.places[0]?.[0];
                    const initCoord = firstPlace ? [firstPlace.lat, firstPlace.lon] : [48.8566, 2.3522];
                    leafletMap = L.map(mapEl).setView(initCoord, 13);
                    addMapTileLayer(leafletMap);
                } catch(e) { leafletMap = null; return; }
            } else {
                leafletMap.eachLayer(layer => {
                    if (layer instanceof L.Marker || layer instanceof L.Polyline) leafletMap.removeLayer(layer);
                });
            }

            Object.values(allDaysMapLayers).forEach(lg => { try { leafletMap.removeLayer(lg); } catch(e){} });
            allDaysPlaceInfo = {};
            allDaysRouteData = {};
            allDaysMapLayers = {};

            const allBounds = [];

            for (let dayIndex = 0; dayIndex < planDays.length; dayIndex++) {
                const prePlaces = route.places[dayIndex];
                if (!prePlaces?.length) continue;
                const color = dayColors[dayIndex % dayColors.length];

                const placeInfo = prePlaces.map((p, i) => ({ num: i + 1, name: p.name, lat: p.lat, lon: p.lon }));
                allDaysPlaceInfo[dayIndex] = placeInfo;

                const layerGroup = L.layerGroup();

                placeInfo.forEach(place => {
                    const icon = L.divIcon({
                        html: `<div class="nm-pin" style="background:${color};animation-delay:${(place.num-1)*0.06}s"><span>${place.num}</span></div>`,
                        iconSize: [36, 36], iconAnchor: [18, 36], className: 'numbered-marker'
                    });
                    const marker = L.marker([place.lat, place.lon], {icon})
                        .bindPopup(`<b>День ${planDays[dayIndex]?.dayNum || dayIndex+1}: ${place.num}. ${place.name}</b>`);
                    marker.on('click', () => selectDay(dayIndex));
                    layerGroup.addLayer(marker);
                    allBounds.push([place.lat, place.lon]);
                });

                if (placeInfo.length >= 2) {
                    try {
                        const routePoints = placeInfo.map(p => ({lat: p.lat, lon: p.lon}));
                        const resp = await fetch('/api/route', {
                            method: 'POST', headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({points: routePoints, profile: 'foot'})
                        });
                        if (resp.ok) {
                            const rd = await resp.json();
                            if (rd.success && rd.geometry?.coordinates) {
                                rd.distance_km = Math.round(rd.distance / 100) / 10;
                                rd.duration_min = Math.max(1, Math.round(rd.duration / 60));
                                allDaysRouteData[dayIndex] = rd;
                                const routeCoords = rd.geometry.coordinates.map(c => [c[1], c[0]]);
                                const polyline = L.polyline(routeCoords, {
                                    color: color, weight: 5, opacity: 0.8,
                                    lineCap: 'round', lineJoin: 'round'
                                });
                                polyline.on('click', () => selectDay(dayIndex));
                                layerGroup.addLayer(polyline);
                            }
                        }
                    } catch(e) {}
                }

                layerGroup.addTo(leafletMap);
                allDaysMapLayers[dayIndex] = layerGroup;
            }

            if (allBounds.length > 0) {
                try { leafletMap.fitBounds(L.latLngBounds(allBounds), {padding: [50, 50]}); } catch(e) {}
            }

            buildMapLegend();

            if (planDays.length > 0) selectDay(0);

            setTimeout(() => { try { leafletMap.invalidateSize(); } catch(e) {} }, 300);

            // Load photos for first day
            if (allDaysPlaceInfo[0]) loadPlacePhotos(allDaysPlaceInfo[0], 0);
        }

        async function loadExampleDayPlaces(dayIndex, route) {
            const prePlaces = route.places[dayIndex];
            if (!prePlaces || !prePlaces.length) {
                selectDay(dayIndex);
                return;
            }

            // Build placeInfo from pre-defined coords
            const placeInfo = prePlaces.map((p, i) => ({
                num: i + 1,
                name: p.name,
                lat: p.lat,
                lon: p.lon
            }));

            currentPlaceInfo = placeInfo;
            currentDayIndex = dayIndex;

            // Show map and cards
            document.getElementById('mapSection').classList.remove('hidden');
            document.getElementById('dayText').style.display = 'none';

            let displayText = planDays[dayIndex]?.content || '';
            document.getElementById('dayText').innerHTML = formatDayContent(displayText);

            // Setup map
            const mapEl = document.getElementById('leafletMap');
            if (typeof L !== 'undefined' && mapEl) {
                if (!leafletMap) {
                    try {
                        leafletMap = L.map(mapEl).setView([placeInfo[0].lat, placeInfo[0].lon], 13);
                        addMapTileLayer(leafletMap);
                    } catch(e) { leafletMap = null; }
                } else {
                    leafletMap.eachLayer(layer => {
                        if (layer instanceof L.Marker || layer instanceof L.Polyline) leafletMap.removeLayer(layer);
                    });
                }

                if (leafletMap) {
                    placeInfo.forEach(p => {
                        try {
                            const icon = L.divIcon({
                                html: `<div class="nm-pin" style="background:#005F60;animation-delay:${(p.num-1)*0.06}s"><span>${p.num}</span></div>`,
                                iconSize: [36, 36], iconAnchor: [18, 36],
                                className: 'numbered-marker'
                            });
                            L.marker([p.lat, p.lon], {icon}).addTo(leafletMap).bindPopup(`<b>${p.num}. ${p.name}</b>`);
                        } catch(e) {}
                    });

                    // Build route
                    let routeData = null;
                    if (placeInfo.length >= 2) {
                        try {
                            const routePoints = placeInfo.map(p => ({lat: p.lat, lon: p.lon}));
                            const resp = await fetch('/api/route', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({points: routePoints, profile: 'foot'})
                            });
                            if (resp.ok) {
                                routeData = await resp.json();
                                if (routeData.success && routeData.geometry) {
                                    routeData.distance_km = Math.round(routeData.distance / 100) / 10;
                                    routeData.duration_min = Math.max(1, Math.round(routeData.duration / 60));
                                    const routeCoords = routeData.geometry.coordinates.map(c => [c[1], c[0]]);
                                    L.polyline(routeCoords, {color:'#005F60',weight:4,opacity:0.75,dashArray:'8, 12',lineCap:'round'}).addTo(leafletMap);
                                }
                            }
                        } catch(e) {}
                    }

                    try {
                        const coords = placeInfo.map(p => [p.lat, p.lon]);
                        leafletMap.fitBounds(L.latLngBounds(coords), {padding: [50, 50]});
                        setTimeout(() => { try { leafletMap.invalidateSize(); } catch(e) {} }, 250);
                    } catch(e) {}

                    showPlacesInfo(placeInfo, dayIndex, routeData);
                }
            }

            // Override selectDay to use pre-defined places for this example
            const origSelectDay = window._origSelectDay || selectDay;
            if (!window._origSelectDay) window._origSelectDay = selectDay;
            window.selectDay = function(idx) {
                // For example routes, use pre-defined places
                if (route.places[idx]) {
                    loadExampleDayPlaces(idx, route);
                } else {
                    origSelectDay(idx);
                }
            };
            // Re-bind day buttons
            document.querySelectorAll('.day-btn').forEach((btn, idx) => {
                btn.onclick = () => window.selectDay(idx);
            });

            // Load photos
            loadPlacePhotos(placeInfo, dayIndex);
        }

        // ===== WEATHER =====
        async function fetchWeather(lat, lon) {
            try {
                const body = { lat, lon };
                if (tripData.dateStart && tripData.dateEnd) {
                    body.dateStart = tripData.dateStart;
                    body.dateEnd = tripData.dateEnd;
                }
                const resp = await fetch('/api/weather', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(body)
                });
                const data = await resp.json();
                if (data.success && data.days && data.days.length) {
                    weatherData = data.days;
                    weatherType = data.type || 'forecast';
                    renderWeatherStrip();
                }
            } catch(e) { console.log('Weather fetch error', e); }
        }

        function renderWeatherStrip() {
            const strip = document.getElementById('weatherStrip');
            const label = document.getElementById('weatherLabel');
            if (!weatherData.length) {
                strip.style.display = 'none';
                label.style.display = 'none';
                return;
            }
            strip.style.display = 'flex';
            // Показываем подпись: прогноз или средняя погода
            if (weatherType === 'historical') {
                label.textContent = '📊 Обычная погода в это время (данные за прошлый год)';
                label.style.display = 'block';
            } else {
                label.textContent = '🌤 Прогноз погоды';
                label.style.display = 'block';
            }

            const dayNames = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];

            strip.innerHTML = weatherData.slice(0, Math.max(planDays.length, 7)).map((w, i) => {
                const d = new Date(w.date + 'T00:00:00');
                const dayName = dayNames[d.getDay()];
                const dd = d.getDate();
                const isDay = i < planDays.length;
                const active = isDay && i === currentDayIndex ? 'active' : '';
                const hi = w.temp_max !== null ? Math.round(w.temp_max) : '—';
                const lo = w.temp_min !== null ? Math.round(w.temp_min) : '';
                return `<div class="weather-day ${isDay ? 'has-day' : ''} ${active}" ${isDay ? `onclick="selectDay(${i})"` : ''}>
                    ${isDay ? `<div class="w-daynum">День ${planDays[i].dayNum || (i + 1)}</div>` : ''}
                    <div class="w-emoji">${w.emoji}</div>
                    <div class="w-temp">${hi}°</div>
                    ${lo !== '' ? `<div class="w-templo">${lo}°</div>` : ''}
                    <div class="w-date">${dayName} ${dd}</div>
                </div>`;
            }).join('');
        }

        // ===== BUDGET PARSING & RENDERING =====
        // ─── Budget data extraction (shared) ───
        function extractBudgetData(dayIndex) {
            const day = planDays[dayIndex];
            if (!day) return null;

            const tripInfoEl = document.getElementById('tripInfo');
            const generalText = tripInfoEl ? tripInfoEl.innerText : '';
            const fullText = day.content + '\n' + generalText;
            const lines = fullText.split('\n');

            // Currency pattern: matches ₽, руб, RUB, EUR, €, $, USD etc.
            const _cur = '(?:₽|руб|RUB|EUR|€|\\$|USD|руб\\.|рублей)';
            const categoryDefs = [
                { key: 'food',      emoji: '🍽', label: 'Еда',             color: '#005F60', rx: new RegExp('^[^\\n]*🍽\\s*(?:Еда|Питание)\\s*[:：]\\s*~?\\s*([\\d][\\d\\s.,]*)\\s*' + _cur, 'i') },
                { key: 'transport', emoji: '🚇', label: 'Транспорт',      color: '#4A9496', rx: new RegExp('^[^\\n]*🚇\\s*(?:Транспорт)\\s*[:：]\\s*~?\\s*([\\d][\\d\\s.,]*)\\s*' + _cur, 'i') },
                { key: 'tickets',   emoji: '🎟', label: 'Билеты и входы', color: '#5B8DD9', rx: new RegExp('^[^\\n]*🎟\\s*(?:Билеты|Входы?|Входы и билеты|Билеты и входы)\\s*[:：]\\s*~?\\s*([\\d][\\d\\s.,]*)\\s*' + _cur, 'i') },
                { key: 'hotel',     emoji: '🏨', label: 'Жильё',          color: '#9A7A8E', rx: new RegExp('^[^\\n]*🏨\\s*(?:Жильё|Отель|Проживание)\\s*[:：]\\s*~?\\s*([\\d][\\d\\s.,]*)\\s*' + _cur, 'i') },
                { key: 'shopping',  emoji: '🛍', label: 'Покупки',        color: '#5B8DD9', rx: new RegExp('^[^\\n]*🛍\\s*(?:Покупки|Сувениры?|Покупки/сувениры)\\s*[:：]\\s*~?\\s*([\\d][\\d\\s.,]*)\\s*' + _cur, 'i') },
                { key: 'sim',       emoji: '📱', label: 'Связь',          color: '#6B4A5E', rx: new RegExp('^[^\\n]*📱\\s*(?:Связь|Интернет|SIM|Связь/интернет)\\s*[:：]\\s*~?\\s*([\\d][\\d\\s.,]*)\\s*' + _cur, 'i') }
            ];

            let items = [];
            let total = 0;
            let foundStructured = false;

            for (const line of lines) {
                for (const cat of categoryDefs) {
                    const m = line.match(cat.rx);
                    if (m) {
                        const val = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
                        if (val > 0 && val < 10000000) {
                            if (!items.find(it => it.key === cat.key)) {
                                items.push({ key: cat.key, emoji: cat.emoji, label: cat.label, color: cat.color, sum: val });
                                total += val;
                                foundStructured = true;
                            }
                        }
                    }
                }
            }

            const totalMatch = fullText.match(/(?:💳|ИТОГО)\s*(?:за день)?\s*[:：]\s*~?\s*([\d][\d\s.,]*)\s*(?:₽|руб|RUB|EUR|€|\$|USD|руб\.|рублей)/i);
            if (totalMatch && foundStructured) {
                const explicitTotal = parseFloat(totalMatch[1].replace(/\s/g, '').replace(',', '.'));
                if (explicitTotal > 0 && Math.abs(explicitTotal - total) / total < 0.5) {
                    total = explicitTotal;
                } else if (explicitTotal > total) {
                    total = explicitTotal;
                }
            }

            if (!foundStructured) {
                const dayOnly = day.content;
                const foodPrices = [];
                const transportPrices = [];
                const ticketPrices = [];
                const otherPrices = [];

                for (const line of dayOnly.split('\n')) {
                    const rubleMatch = line.match(/\(~?\s*([\d][\d\s.,]*)\s*(?:₽|RUB|руб|€|EUR|\$|USD)\)/);
                    const plainRuble = line.match(/~?\s*([\d][\d\s.,]*)\s*(?:₽|RUB|руб|€|EUR|\$|USD)/);
                    const priceMatch = rubleMatch || plainRuble;
                    if (!priceMatch) continue;

                    const val = parseFloat(priceMatch[1].replace(/\s/g, '').replace(',', '.'));
                    if (val <= 0 || val >= 10000000) continue;

                    const lower = line.toLowerCase();
                    if (/завтрак|обед|ужин|кафе|ресторан|кофе|еда|чек/.test(lower)) {
                        foodPrices.push(val);
                    } else if (/метро|такси|транспорт|автобус|трамвай|проезд/.test(lower)) {
                        transportPrices.push(val);
                    } else if (/вход|билет|музей|экскурс|галере|башн|собор|дворец/.test(lower)) {
                        ticketPrices.push(val);
                    } else {
                        otherPrices.push(val);
                    }
                }

                const addCat = (emoji, label, color, key, prices) => {
                    const sum = prices.reduce((a, b) => a + b, 0);
                    if (sum > 0) {
                        items.push({ key, emoji, label, color, sum });
                        total += sum;
                    }
                };

                addCat('🍽', 'Еда', '#005F60', 'food', foodPrices);
                addCat('🚇', 'Транспорт', '#4A9496', 'transport', transportPrices);
                addCat('🎟', 'Билеты и входы', '#5B8DD9', 'tickets', ticketPrices);
                if (otherPrices.length > 0) {
                    addCat('💳', 'Прочее', '#8A8386', 'other', otherPrices);
                }
            }

            if (total === 0) return null;
            return { items, total };
        }

        // ─── Render budget for a single day card ───
        function renderDayBudgetCard(dayIndex, data, isCollapsible = false) {
            const dayLabel = planDays[dayIndex] ? `День ${planDays[dayIndex].dayNum || (dayIndex+1)}` : `День ${dayIndex+1}`;
            const collapseId = `budgetDay${dayIndex}`;
            const sym = getCurrSym();
            const calendarSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
            let html = `<div class="budget-card" style="display:block; margin-bottom:10px;">
                <div class="budget-header" ${isCollapsible ? `onclick="document.getElementById('${collapseId}').style.display=document.getElementById('${collapseId}').style.display==='none'?'block':'none'"` : ''}>
                    <div class="bh-left">
                        <div class="bh-icon" style="background:hsl(221 83% 95%); color:var(--accent);">${calendarSvg}</div>
                        <div class="bh-title">${dayLabel}</div>
                    </div>
                    <div class="bh-total">~${Math.round(data.total).toLocaleString('ru-RU')} ${sym}</div>
                </div>
                <div class="budget-body" id="${collapseId}" style="display:${isCollapsible ? 'none' : 'block'};">`;

            data.items.forEach(item => {
                const pct = Math.round((item.sum / data.total) * 100);
                html += `<div class="budget-row">
                    <div class="br-left">${budgetIconHtml(item.key)}<span class="br-label">${item.label}</span></div>
                    <div class="br-value">${Math.round(item.sum).toLocaleString('ru-RU')} ${sym}<span class="br-pct">${pct}%</span></div>
                </div>`;
            });

            html += '<div class="budget-bar-wrap">';
            data.items.forEach(item => {
                const pct = Math.max(4, (item.sum / data.total) * 100);
                html += `<div class="budget-bar-seg" style="width:${pct}%;background:${item.color}"></div>`;
            });
            html += '</div></div></div>';
            return html;
        }

        // ─── Full budget panel: all days + grand total ───
        function renderFullBudgetPanel(panel) {
            const sym = getCurrSym();
            if (!planDays || planDays.length === 0) {
                panel.innerHTML = `<div style="padding:24px 20px; text-align:center; color:var(--text-muted); font-size:14px;">${budgetIcons.total} Бюджет будет доступен после генерации маршрута</div>`;
                return;
            }

            // Collect budget data for all days
            const allDayData = [];
            let grandTotal = 0;
            const grandCategories = {}; // key -> { label, color, sum }

            for (let i = 0; i < planDays.length; i++) {
                const data = extractBudgetData(i);
                allDayData.push(data);
                if (data) {
                    grandTotal += data.total;
                    data.items.forEach(item => {
                        if (!grandCategories[item.key]) {
                            grandCategories[item.key] = { label: item.label, color: item.color, sum: 0 };
                        }
                        grandCategories[item.key].sum += item.sum;
                    });
                }
            }

            if (grandTotal === 0) {
                panel.innerHTML = '<div style="padding:24px 20px; text-align:center; color:var(--text-muted); font-size:14px;">💰 Данные о бюджете не найдены в маршруте</div>';
                return;
            }

            let html = '';

            // ─── Grand total card at top ───
            const grandItems = Object.entries(grandCategories).map(([key, v]) => ({key, ...v})).sort((a, b) => b.sum - a.sum);
            html += `<div class="budget-card" style="display:block; margin-bottom:14px; border: 2px solid var(--accent);">
                <div class="budget-header" style="background: linear-gradient(135deg, hsl(211 100% 97%), hsl(142 70% 97%));">
                    <div class="bh-left">
                        <div class="bh-icon" style="background: var(--accent); color: #fff;">${budgetIcons.total}</div>
                        <div>
                            <div class="bh-title">Общий бюджет</div>
                            <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">${planDays.length} ${planDays.length === 1 ? 'день' : planDays.length < 5 ? 'дня' : 'дней'}</div>
                        </div>
                    </div>
                    <div class="bh-total" style="font-size:20px;">~${Math.round(grandTotal).toLocaleString('ru-RU')} ${sym}</div>
                </div>
                <div class="budget-body" style="display:flex; flex-direction:column; gap:6px;">`;

            grandItems.forEach(item => {
                if (item.sum <= 0) return;
                const pct = Math.round((item.sum / grandTotal) * 100);
                html += `<div class="budget-row">
                    <div class="br-left">${budgetIconHtml(item.key)}<span class="br-label">${item.label}</span></div>
                    <div class="br-value">${Math.round(item.sum).toLocaleString('ru-RU')} ${sym}<span class="br-pct">${pct}%</span></div>
                </div>`;
            });

            html += '<div class="budget-bar-wrap">';
            grandItems.forEach(item => {
                if (item.sum <= 0) return;
                const pct = Math.max(4, (item.sum / grandTotal) * 100);
                html += `<div class="budget-bar-seg" style="width:${pct}%;background:${item.color}"></div>`;
            });
            html += '</div></div></div>';

            // ─── Per-day breakdown (collapsible) ───
            html += `<div style="font-size:13px; font-weight:600; color:var(--text-muted); padding:6px 4px 8px; text-transform:uppercase; letter-spacing:0.5px;">Расходы по дням</div>`;

            for (let i = 0; i < planDays.length; i++) {
                const data = allDayData[i];
                if (data) {
                    html += renderDayBudgetCard(i, data, true);
                } else {
                    const dayLabel = planDays[i] ? `День ${planDays[i].dayNum || (i+1)}` : `День ${i+1}`;
                    html += `<div class="budget-card" style="display:block; margin-bottom:10px;">
                        <div class="budget-header">
                            <div class="bh-left">
                                <div class="bh-icon" style="background:hsl(221 83% 95%); color:var(--accent);"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></div>
                                <div class="bh-title">${dayLabel}</div>
                            </div>
                            <div class="bh-total" style="color:var(--text-muted); font-size:13px;">нет данных</div>
                        </div>
                    </div>`;
                }
            }

            panel.innerHTML = html;
        }

        // Tab switching for bottom navigation
        let activeRoamyTab = 'wishes';
        // ===== Feedback modal =====
        let _fbRating = null;
        function openFeedback() {
            const ov = document.getElementById('fbOverlay');
            if (!ov) return;
            ov.classList.add('active');
            document.body.style.overflow = 'hidden';
            setTimeout(() => { document.getElementById('fbText')?.focus(); }, 200);
        }
        function closeFeedback() {
            const ov = document.getElementById('fbOverlay');
            if (!ov) return;
            ov.classList.remove('active');
            document.body.style.overflow = '';
            setTimeout(() => {
                _fbRating = null;
                document.querySelectorAll('#fbRating .fb-rating-btn').forEach(b => b.classList.remove('selected'));
                const t = document.getElementById('fbText'); if (t) t.value = '';
                const c = document.getElementById('fbContact'); if (c) c.value = '';
                const s = document.getElementById('fbStatus'); if (s) { s.textContent = ''; s.classList.remove('error'); }
                const sb = document.getElementById('fbSubmit'); if (sb) { sb.disabled = false; sb.textContent = 'Отправить'; }
            }, 300);
        }
        function fbPickRating(r) {
            _fbRating = r;
            document.querySelectorAll('#fbRating .fb-rating-btn').forEach(b => {
                b.classList.toggle('selected', parseInt(b.dataset.r, 10) === r);
            });
            try { if (window.Telegram?.WebApp?.HapticFeedback) window.Telegram.WebApp.HapticFeedback.selectionChanged(); } catch (e) {}
        }
        async function submitFeedback() {
            const text = (document.getElementById('fbText')?.value || '').trim();
            const contact = (document.getElementById('fbContact')?.value || '').trim();
            const status = document.getElementById('fbStatus');
            const submitBtn = document.getElementById('fbSubmit');
            if (!_fbRating && !text) {
                if (status) { status.classList.add('error'); status.textContent = 'Поставьте оценку или напишите пару слов'; }
                return;
            }
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Отправляем…'; }
            if (status) { status.classList.remove('error'); status.textContent = ''; }
            try {
                const resp = await fetch('/api/feedback', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        rating: _fbRating,
                        text,
                        contact,
                        destination: (typeof tripData !== 'undefined' && tripData.destination) ? tripData.destination : '',
                    })
                });
                const data = await resp.json();
                if (!data.success) throw new Error(data.error || 'Не удалось отправить');
                if (status) status.textContent = '✓ Спасибо за фидбек!';
                try { if (window.Telegram?.WebApp?.HapticFeedback) window.Telegram.WebApp.HapticFeedback.notificationOccurred('success'); } catch (e) {}
                setTimeout(closeFeedback, 1200);
            } catch (err) {
                if (status) { status.classList.add('error'); status.textContent = (err && err.message) || 'Ошибка отправки'; }
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Отправить'; }
            }
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.getElementById('fbOverlay')?.classList.contains('active')) {
                closeFeedback();
            }
        });

        function switchRoamyTab(tab) {
            const tabs = ['wishes', 'budget', 'booking', 'tips', 'share'];

            document.querySelectorAll('.roamy-tab-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === tab);
            });

            const routeContent = document.getElementById('routeContent');
            const daySelection = document.getElementById('daySelection');
            const sheet = document.getElementById('resultSheet');
            const sheetScroll = document.getElementById('sheetScroll');

            if (tab === 'wishes') {
                if (routeContent) routeContent.style.display = '';
                if (daySelection) daySelection.style.display = '';
                if (window._sheet) window._sheet.snapTo(window._sheet.SNAP.MID);
                else if (sheet) sheet.classList.remove('sheet-expanded');
                if (sheetScroll) sheetScroll.scrollTop = 0;
            } else {
                if (routeContent) routeContent.style.display = 'none';
                if (daySelection) daySelection.style.display = 'none';
                if (window._sheet) window._sheet.snapTo(window._sheet.SNAP.FULL);
                else if (sheet) sheet.classList.add('sheet-expanded');
            }

            tabs.forEach(t => {
                const panel = document.getElementById('roamyPanel' + t.charAt(0).toUpperCase() + t.slice(1));
                if (panel) panel.style.display = (t === tab && t !== 'wishes') ? 'block' : 'none';
            });

            const tripInfo = document.getElementById('tripInfo');
            if (tab === 'tips' && tripInfo) tripInfo.style.display = 'block';

            if (tab === 'budget') {
                const budgetPanel = document.getElementById('roamyPanelBudget');
                if (budgetPanel) {
                    if (currentPlanJson && currentPlanJson.dailyBudget) {
                        const b = currentPlanJson.dailyBudget;
                        const fields = [
                            ['food', 'Еда'],
                            ['transport', 'Транспорт'],
                            ['tickets', 'Билеты'],
                            ['shopping', 'Покупки'],
                            ['lodging', 'Жильё'],
                            ['total', 'Итого за день'],
                        ];
                        budgetPanel.innerHTML = '<div class="page-editor"><h3>Бюджет</h3><p class="page-editor-sub">Отдельная страница расходов — правки пишутся в кабинет.</p>' +
                            fields.map(([k, l]) => `<label class="page-field"><span>${l}</span><input data-budget="${k}" value="${esc(b[k] || '')}"></label>`).join('') +
                            '<button type="button" class="page-save-btn" onclick="saveBudgetPage()">Сохранить страницу</button></div>';
                    } else {
                        renderFullBudgetPanel(budgetPanel);
                    }
                }
            }
            if (tab === 'tips') renderTipsPage();
            if (tab === 'booking') renderHotelsPage();

            activeRoamyTab = tab;
        }

        // Legacy compat — keep old switchTab working
        function switchTab(tab) {
            if (tab === 'booking') switchRoamyTab('booking');
            else if (tab === 'info') switchRoamyTab('tips');
        }

        // ===== SHARE TRIP =====
        let currentPlanText = '';  // raw plan from API

        async function shareTrip() {
            const btn = document.querySelector('.btn-share');
            if (!currentPlanText) { return; }
            btn.textContent = '⏳ Создаём ссылку…';
            btn.disabled = true;
            try {
                const resp = await fetch('/api/share', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        plan: currentPlanText,
                        destination: tripData.destination || '',
                        daysCount: tripData.daysCount || planDays.length,
                        budget: tripData.budget || '',
                        travelers: tripData.travelers || '',
                        coords: destCoords,
                        userId: tg?.initDataUnsafe?.user?.id || 'anonymous'
                    })
                });
                const data = await resp.json();
                if (data.success) {
                    const url = `${location.origin}/trip/${data.shareId}`;
                    // Try native share first (works great on mobile / Telegram)
                    if (navigator.share) {
                        await navigator.share({
                            title: `✈️ Маршрут: ${tripData.destination || 'Путешествие'}`,
                            text: `Смотри мой маршрут в ${tripData.destination || 'путешествие'}!`,
                            url: url
                        });
                    } else {
                        // Fallback: copy to clipboard
                        await navigator.clipboard.writeText(url);
                        showShareToast();
                    }
                }
            } catch (e) {
                console.error('Share error:', e);
            } finally {
                btn.innerHTML = '✈️ Поделиться';
                btn.disabled = false;
            }
        }

        function showShareToast() {
            const t = document.getElementById('shareToast');
            t.classList.add('visible');
            setTimeout(() => t.classList.remove('visible'), 2500);
        }

        // ===== LOAD SHARED TRIP =====
        async function checkSharedTrip() {
            const m = location.pathname.match(/^\/trip\/([a-f0-9]+)$/);
            if (!m) return;
            const shareId = m[1];
            try {
                const resp = await fetch(`/api/shared/${shareId}`);
                const data = await resp.json();
                if (!data.success) return;

                // Hide wizard, show result
                document.querySelectorAll('[id^="step"]').forEach(el => el.classList.add('hidden'));
                document.getElementById('stepIndicator')?.classList.add('hidden');
                document.getElementById('result').classList.remove('hidden');

                // Fill trip data
                tripData.destination = data.destination || '';
                currentPlanText = data.plan || '';
                destCoords = data.coords || null;

                if (destCoords) fetchWeather(destCoords.lat, destCoords.lon);

                parsePlanDays(data.plan || '');
            } catch (e) {
                console.error('Shared trip load error:', e);
            }
        }

        async function loadOwnedTrip() {
            if (/^\/trip\//.test(location.pathname)) return false;
            let tripId = '';
            try {
                tripId = new URLSearchParams(location.search).get('trip') || '';
            } catch (e) {}
            if (!tripId) return false;
            try {
                const resp = await fetch('/api/trips/' + encodeURIComponent(tripId));
                const data = await resp.json();
                if (!resp.ok || !data.success || !data.planJson) return false;
                tripData = Object.assign({}, tripData, {
                    destination: data.destination || '',
                    daysCount: data.daysCount || (data.planJson.days || []).length,
                });
                destCoords = data.coords || destCoords;
                processApiResult({
                    success: true,
                    plan: data.planText || data.plan || '',
                    planJson: data.planJson,
                    coords: data.coords,
                    access: data.access,
                    tripId: data.id,
                    pages: data.pages,
                    source: 'store',
                });
                return true;
            } catch (e) {
                console.warn('loadOwnedTrip failed', e);
                return false;
            }
        }

        function restoreActiveTrip() {
            if (/^\/trip\//.test(location.pathname)) return false;
            let saved = null;
            try {
                saved = JSON.parse(sessionStorage.getItem(TB_ACTIVE_KEY) || 'null');
            } catch (e) {
                return false;
            }
            if (!saved || !(saved.plan || saved.planJson)) return false;
            if (saved.savedAt && Date.now() - saved.savedAt > 6 * 3600 * 1000) {
                clearActiveTrip();
                return false;
            }
            tripData = Object.assign({}, tripData, saved.tripData || {});
            try {
                processApiResult({
                    success: true,
                    plan: saved.plan,
                    planJson: saved.planJson,
                    coords: saved.coords,
                    access: saved.access,
                    tripId: saved.tripId,
                    pages: saved.pages,
                    source: saved.source,
                });
                return true;
            } catch (e) {
                console.warn('restoreActiveTrip failed', e);
                return false;
            }
        }

        // ═══ Главное меню: экраны работают как шаги мастера — мгновенно, без перезагрузки ═══
        const TB_SCR_CACHE_KEY = 'tbScrCache.v1';
        const MAIN_TAB_SCREENS = { home: 'step1', trips: 'screenTrips', pricing: 'screenPricing', cabinet: 'screenCabinet' };
        let currentMainTab = 'home';

        const escH = (s) => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

        function tbScrCacheRead() {
            try { return JSON.parse(localStorage.getItem(TB_SCR_CACHE_KEY) || '{}') || {}; } catch (e) { return {}; }
        }
        function tbScrCacheWrite(patch) {
            try {
                const c = tbScrCacheRead();
                Object.assign(c, patch);
                localStorage.setItem(TB_SCR_CACHE_KEY, JSON.stringify(c));
            } catch (e) {}
        }
        async function tbApiGet(path) {
            try {
                const r = await fetch(path);
                const d = await r.json();
                return d && typeof d === 'object' ? d : {};
            } catch (e) { return {}; }
        }
        function tbFormatRub(n) {
            try { return new Intl.NumberFormat('ru-RU').format(Number(n) || 0) + ' ₽'; } catch (e) { return n + ' ₽'; }
        }
        function tbFmtDate(iso) {
            try { return new Date(iso).toLocaleDateString('ru-RU'); } catch (e) { return ''; }
        }

        function switchMainTab(tab, skipUrl) {
            if (!MAIN_TAB_SCREENS[tab]) tab = 'home';
            currentMainTab = tab;
            // Выходим из режимов загрузки/результата, чтобы экраны меню были видны
            document.body.classList.remove('loading-mode', 'result-mode');
            document.getElementById('loading')?.classList.add('hidden');
            document.getElementById('result')?.classList.add('hidden');
            const bt = document.getElementById('bottomTabs');
            if (bt) bt.style.display = 'none';
            ['step1', 'step2', 'step3', 'screenTrips', 'screenPricing', 'screenCabinet'].forEach((id) => {
                document.getElementById(id)?.classList.add('hidden');
            });
            // Если маршрут уже собран и открыт — «Главная» возвращает к нему (как раньше при переходе на /)
            if (tab === 'home' && planDays && planDays.length) {
                document.getElementById('result')?.classList.remove('hidden');
                document.body.classList.add('result-mode');
                const bt2 = document.getElementById('bottomTabs');
                if (bt2) bt2.style.display = 'block';
                // Возвращаем на вкладку «Маршрут», если был открыт другой раздел листа
                try { switchRoamyTab('wishes'); } catch (e) {}
            } else {
                const target = document.getElementById(MAIN_TAB_SCREENS[tab]);
                if (target) target.classList.remove('hidden');
            }
            const ind = document.getElementById('stepIndicator');
            if (ind) ind.style.display = tab === 'home' ? '' : 'none';
            const lbl = document.getElementById('headerStepLabel');
            if (lbl) lbl.style.display = tab === 'home' ? '' : 'none';
            document.querySelectorAll('.main-tab-btn').forEach((b) => {
                b.classList.toggle('is-active', b.getAttribute('data-main-tab') === tab);
            });
            window.scrollTo({ top: 0, behavior: 'auto' });
            if (!skipUrl) {
                try { history.replaceState(null, '', tab === 'home' ? location.pathname : '?tab=' + tab); } catch (e) {}
            }
            if (tg?.HapticFeedback) tg.HapticFeedback.selectionChanged();
            if (tab === 'trips') renderTripsScreen();
            else if (tab === 'pricing') renderPricingScreen();
            else if (tab === 'cabinet') renderCabinetScreen();
        }
        window.switchMainTab = switchMainTab;

        // ── Экран «Мои путешествия» ──
        let tripsScreenReq = 0;
        function renderTripsScreen(fromCacheOnly) {
            const body = document.getElementById('tripsScreenBody');
            if (!body) return;
            const cache = tbScrCacheRead();
            const trips = Array.isArray(cache.trips) ? cache.trips : null;
            const gold = Array.isArray(cache.goldRoutes) ? cache.goldRoutes : [];
            body.innerHTML = tripsScreenHtml(trips, gold);
            if (fromCacheOnly) return;
            const reqId = ++tripsScreenReq;
            Promise.all([tbApiGet('/api/me/trips'), tbApiGet('/api/gold-routes')]).then(([tr, gr]) => {
                if (reqId !== tripsScreenReq) return;
                const list = Array.isArray(tr.trips) ? tr.trips : [];
                const routes = Array.isArray(gr.routes) ? gr.routes : [];
                tbScrCacheWrite({ trips: list, goldRoutes: routes });
                if (currentMainTab === 'trips') {
                    const b2 = document.getElementById('tripsScreenBody');
                    if (b2) b2.innerHTML = tripsScreenHtml(list, routes);
                }
            });
        }

        function tbRecsHtml(gold) {
            const demos = exampleRoutes.filter((r) => r.demo);
            const demoIds = new Set(demos.map((d) => d.id));
            const goldCards = (gold || []).filter((g) => !demoIds.has(g.id)).slice(0, 4);
            const cards = [...demos, ...goldCards];
            return cards.map((r) => `
                <button type="button" class="tb-rec-card" onclick="tbOpenRec('${escH(r.id)}')">
                    <img src="${escH(r.img || '/img/destinations/altai.jpg')}" alt="" loading="eager" decoding="async" onerror="this.onerror=null;this.src='/img/destinations/altai.jpg'">
                    <div class="tb-rec-meta">
                        <div class="tb-rec-title">${escH(r.title)}</div>
                        <div class="tb-rec-sub">${r.days} дн · ${escH(r.city)}</div>
                    </div>
                </button>`).join('');
        }

        function tripsScreenHtml(trips, gold) {
            const recsBlock = `
                <div class="tb-recs-label">Попробуйте так</div>
                <div class="tb-recs-row">${tbRecsHtml(gold)}</div>`;
            if (!trips) {
                // Кэша ещё нет: рекомендации показываем мгновенно, список подтянется следом
                return `<div class="tb-cab-text">Загружаем поездки…</div>` + recsBlock;
            }
            if (!trips.length) {
                return `
                    <div class="tb-empty">
                        <p>Пока здесь пусто. Время спланировать новое приключение!</p>
                        <div style="margin-top:18px"><button type="button" class="tb-btn" onclick="switchMainTab('home')">Собрать маршрут</button></div>
                    </div>` + recsBlock;
            }
            const rows = trips.map((t) => {
                const plus = Number(t.visibleDays) < Number(t.daysCount);
                return `
                <div class="tb-trip-card">
                    <div class="tb-trip-head">
                        <div style="min-width:0">
                            <div class="tb-trip-title">${escH(t.title || t.destination)}</div>
                            <div class="tb-trip-meta">
                                <span>${escH(t.destination)}</span>
                                <span>${t.visibleDays} из ${t.daysCount} дн.</span>
                            </div>
                        </div>
                        ${plus ? '<span class="tb-plus-badge">Plus</span>' : ''}
                    </div>
                    <div class="tb-trip-date">${tbFmtDate(t.createdAt)}</div>
                    <div class="tb-trip-actions">
                        <button type="button" class="tb-btn small" onclick="openTripFromList('${escH(t.id)}')">Открыть</button>
                        <button type="button" class="tb-icon-btn" onclick="deleteTripFromList('${escH(t.id)}')" aria-label="Удалить">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </div>
                </div>`;
            }).join('');
            return `
                <p class="tb-cab-text">Активные и прошлые маршруты. Первые два дня каждого города остаются теми же при любом повторном запросе.</p>
                <div style="margin-top:14px"><button type="button" class="tb-btn small" onclick="switchMainTab('home')">Собрать новый план</button></div>
                <div class="tb-trip-list">${rows}</div>`;
        }

        function tbOpenRec(id) {
            switchMainTab('home');
            setTimeout(() => showRouteSheet(id), 80);
        }
        window.tbOpenRec = tbOpenRec;

        async function openTripFromList(id) {
            switchMainTab('home');
            showLoadingView();
            try {
                const resp = await fetch('/api/trips/' + encodeURIComponent(id));
                const data = await resp.json();
                if (!resp.ok || !data.success || !data.planJson) throw new Error('not found');
                tripData = Object.assign({}, tripData, {
                    destination: data.destination || '',
                    daysCount: data.daysCount || (data.planJson.days || []).length,
                });
                destCoords = data.coords || destCoords;
                onApiComplete({
                    success: true,
                    plan: data.planText || data.plan || '',
                    planJson: data.planJson,
                    coords: data.coords,
                    access: data.access,
                    tripId: data.id,
                    pages: data.pages,
                    source: 'store',
                });
            } catch (e) {
                onApiComplete(buildClientFallback('open'));
            }
        }
        window.openTripFromList = openTripFromList;

        async function deleteTripFromList(id) {
            if (!window.confirm('Удалить поездку?')) return;
            try {
                await fetch('/api/trips/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tripId: id }),
                });
            } catch (e) {}
            const cache = tbScrCacheRead();
            const list = Array.isArray(cache.trips) ? cache.trips.filter((t) => t.id !== id) : [];
            tbScrCacheWrite({ trips: list });
            if (currentMainTab === 'trips') renderTripsScreen(true);
        }
        window.deleteTripFromList = deleteTripFromList;

        // ── Экран «Тарифы» ──
        const TB_FALLBACK_OFFERS = [
            {
                id: 'plus-month', title: 'TravelBase Plus', subtitle: 'месяц',
                description: 'Полные маршруты без лимита в 2 дня. Карты, бюджет, лайфхаки и кабинет.',
                price_rub: 349, period: 'month',
                features: ['Все дни маршрута, не только 2 бесплатных', 'Сохранение поездок в кабинете', 'Повторная генерация без кэша бесплатных дней', 'Приоритетная сборка маршрутов'],
            },
            {
                id: 'plus-year', title: 'TravelBase Plus', subtitle: 'год',
                description: 'Годовая подписка со скидкой. Выгоднее месяца почти вдвое.',
                price_rub: 2490, period: 'year',
                features: ['Все дни маршрута на 12 месяцев', 'Сохранение поездок в кабинете', 'Повторная генерация без кэша бесплатных дней', 'Приоритетная сборка маршрутов', '−40% к месячной цене'],
            },
        ];
        function renderPricingScreen() {
            const body = document.getElementById('pricingScreenBody');
            if (!body) return;
            const cache = tbScrCacheRead();
            const offers = Array.isArray(cache.offers) && cache.offers.length ? cache.offers : TB_FALLBACK_OFFERS;
            body.innerHTML = pricingScreenHtml(offers);
            tbApiGet('/api/offers').then((d) => {
                const list = Array.isArray(d.offers) && d.offers.length ? d.offers : null;
                if (!list) return;
                tbScrCacheWrite({ offers: list });
                if (currentMainTab === 'pricing') {
                    const b2 = document.getElementById('pricingScreenBody');
                    if (b2) b2.innerHTML = pricingScreenHtml(list);
                }
            });
        }
        function pricingScreenHtml(offers) {
            return '<div class="tb-offer-grid">' + offers.map((o) => `
                <article class="tb-offer-card">
                    <div class="tb-offer-period">${escH(o.subtitle || '')}</div>
                    <div class="tb-offer-title">${escH(o.title)}</div>
                    <div class="tb-offer-price">${tbFormatRub(o.price_rub)}</div>
                    <p class="tb-offer-desc">${escH(o.description || '')}</p>
                    <ul class="tb-offer-feats">${(o.features || []).map((f) => `<li>${escH(f)}</li>`).join('')}</ul>
                    <button type="button" class="tb-btn" onclick="tbChooseOffer('${escH(o.id)}')">Оформить</button>
                </article>`).join('') + '</div>';
        }
        function tbChooseOffer(id) {
            location.href = '/checkout?offer=' + encodeURIComponent(id);
        }
        window.tbChooseOffer = tbChooseOffer;

        // ── Экран «Личный кабинет» ──
        function renderCabinetScreen() {
            const body = document.getElementById('cabinetScreenBody');
            if (!body) return;
            const cache = tbScrCacheRead();
            body.innerHTML = cabinetScreenHtml(cache.me || null, cache.purchases || null, cache.favorites || null);
            Promise.all([tbApiGet('/api/me'), tbApiGet('/api/me/purchases'), tbApiGet('/api/me/favorites')]).then(([me, pu, fav]) => {
                const meData = me && me.success ? me : { success: true, user: null, subscription: { subscribed: false, status: 'free' } };
                const purchases = Array.isArray(pu.purchases) ? pu.purchases : [];
                const favorites = Array.isArray(fav.favorites) ? fav.favorites : [];
                tbScrCacheWrite({ me: meData, purchases, favorites });
                if (currentMainTab === 'cabinet') {
                    const b2 = document.getElementById('cabinetScreenBody');
                    if (b2) b2.innerHTML = cabinetScreenHtml(meData, purchases, favorites);
                }
            });
        }

        function cabinetScreenHtml(me, purchases, favorites) {
            const tgUser = (() => { try { return tg?.initDataUnsafe?.user || null; } catch (e) { return null; } })();
            const user = me && me.user ? me.user : null;
            const sub = (me && me.subscription) || { subscribed: false, status: 'free', expiresAt: null };
            const name = (tgUser && (tgUser.first_name || (tgUser.username ? '@' + tgUser.username : null)))
                || (user && user.email) || 'Путешественник';
            const nameEl = document.getElementById('cabinetName');
            if (nameEl) nameEl.textContent = name;
            const uid = (user && user.id) || (tgUser && tgUser.id) || 'guest';
            const refLink = 'https://t.me/TravelBaseBot/app?startapp=ref_' + uid;
            const inTg = Boolean(tg && tg.initData);

            let html = '';

            if (me && !user && !inTg) {
                html += `
                    <div class="tb-empty">
                        <p>Войдите, чтобы сохранять поездки и открыть все дни маршрутов.</p>
                        <div style="margin-top:18px"><a class="tb-btn" href="/login">Войти</a></div>
                    </div>`;
            }

            // Подписка
            html += `
                <div class="tb-cab-section">
                    <div class="tb-card tb-cab-card" style="margin-top:0">
                        <div class="tb-sub-row">
                            <div style="min-width:0">
                                <div class="tb-cab-label" style="font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(28,23,25,0.4)">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#2D68C4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>
                                    Моя подписка
                                </div>
                                <div class="tb-sub-name">${sub.subscribed ? 'TravelBase Plus' : 'Бесплатный тариф'}</div>
                                <p class="tb-sub-desc">${sub.subscribed
                                    ? 'Все дни маршрута открыты до ' + (sub.expiresAt ? tbFmtDate(sub.expiresAt) : 'конца периода') + '.'
                                    : 'В каждом городе доступны первые 2 дня. Полный план — с подпиской Plus.'}</p>
                            </div>
                            ${!sub.subscribed ? '<button type="button" class="tb-btn small" onclick="switchMainTab(\'pricing\')">Открыть Plus</button>' : ''}
                        </div>
                    </div>
                </div>`;

            // Избранное: из API для авторизованных, из localStorage для гостей
            let favs = Array.isArray(favorites) ? favorites : null;
            if (!favs || !favs.length) {
                try {
                    const local = tbFavStore();
                    if (local.length) {
                        favs = local.slice(0, 20).map((f) => ({ kind: f.kind, itemKey: f.key, title: f.title || f.key }));
                    }
                } catch (e) {}
            }
            html += `<div class="tb-cab-section">
                <div class="tb-cab-label">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#3C2433" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
                    Избранное
                </div>`;
            if (!favs || !favs.length) {
                html += `<p class="tb-cab-text">Пока пусто. Нажимайте сердечко на городах и маршрутах — они появятся здесь.</p>`;
            } else {
                html += '<div class="tb-list">' + favs.slice(0, 20).map((f) => {
                    const kind = f.kind || '';
                    const key = f.itemKey || f.key || '';
                    const title = f.title || key;
                    return `<div class="tb-list-row">
                        <span class="t">${escH(title)}</span>
                        <button type="button" class="tb-link" onclick="tbOpenFav('${escH(kind)}','${encodeURIComponent(key)}','${encodeURIComponent(title)}')">Открыть</button>
                    </div>`;
                }).join('') + '</div>';
            }
            html += '</div>';

            // Друзья
            html += `
                <div class="tb-cab-section">
                    <div class="tb-card tb-cab-card">
                        <div class="tb-cab-label">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#005F60" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                            Друзья
                        </div>
                        <p class="tb-cab-text">Приглашайте друзей — за каждого, кто откроет приложение по вашей ссылке, вы получите бонусные дни маршрутов.</p>
                        <div class="tb-ref-row">
                            <div class="tb-ref-link">${escH(refLink)}</div>
                            <button type="button" class="tb-btn small" onclick="tbCopyRef(this,'${escH(refLink)}')">Копировать</button>
                        </div>
                    </div>
                </div>`;

            // Быстрые ссылки
            html += `
                <div class="tb-quick-grid">
                    <button type="button" class="tb-quick-card" onclick="switchMainTab('trips')">
                        <div class="tb-quick-kicker">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/></svg>
                            Поездки
                        </div>
                        <div class="tb-quick-title">Сохранённые маршруты</div>
                    </button>
                    <a class="tb-quick-card" href="/offer">
                        <div class="tb-quick-kicker">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>
                            Документы
                        </div>
                        <div class="tb-quick-title">Оферта и соглашение</div>
                    </a>
                </div>`;

            // Покупки
            html += `<div class="tb-cab-section">
                <div class="tb-cab-label">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#2D68C4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
                    Покупки
                </div>`;
            if (!purchases || !purchases.length) {
                html += `<p class="tb-cab-text">Платежей пока нет.</p>`;
            } else {
                html += '<div class="tb-list">' + purchases.map((p) => `
                    <div class="tb-list-row">
                        <span class="t">${escH(p.offerId)} · ${p.status === 'paid' ? 'оплачено' : escH(p.status)}</span>
                        <span class="v">${tbFormatRub(p.amountRub)} · ${tbFmtDate(p.createdAt)}</span>
                    </div>`).join('') + '</div>';
            }
            html += '</div>';

            return html;
        }

        function tbOpenFav(kind, keyEnc, titleEnc) {
            const key = decodeURIComponent(keyEnc || '');
            const title = decodeURIComponent(titleEnc || '');
            if (kind === 'route') { tbOpenRec(key); return; }
            switchMainTab('home');
            setTimeout(() => {
                if (typeof selectUnifiedDestination === 'function') selectUnifiedDestination(title || key, '', '');
            }, 80);
        }
        window.tbOpenFav = tbOpenFav;

        function tbCopyRef(btn, link) {
            const done = () => {
                const old = btn.textContent;
                btn.textContent = 'Скопировано';
                setTimeout(() => { btn.textContent = old; }, 1800);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(link).then(done).catch(done);
            } else {
                done();
            }
        }
        window.tbCopyRef = tbCopyRef;

        // init selects
        window.__tbBoot = function __tbBoot() {
            initOnboard();
            initPopularDestinations();
            initExampleRoutes();
            void tbLoadFavs();
            initCurrencyGrid();
            initCountryCitySelectors();
            initMainButton();
            setTripMode('dates');
            checkSharedTrip();
            initS1Typewriter();
            initS1CardTilt();
            initS1CtaAutoHide();
            initWishesChips();
            loadCurrencyRates();
            detectUserCity();
            void loadOwnedTrip().then((ok) => { if (!ok) restoreActiveTrip(); });
            try {
                const params = new URLSearchParams(location.search);
                const ex = params.get('example');
                if (ex) setTimeout(() => showRouteSheet(ex), 500);
                const start = params.get('start');
                if (start && typeof selectUnifiedDestination === 'function') {
                    setTimeout(() => selectUnifiedDestination(start, 'Россия', '🇷🇺'), 400);
                }
                const tab = params.get('tab');
                if (tab && tab !== 'home' && MAIN_TAB_SCREENS[tab]) {
                    setTimeout(() => switchMainTab(tab), 60);
                }
            } catch (e) {}

            // ── Sheet drag-to-resize ──
            (function initSheetManager() {
                const sheet   = document.getElementById('resultSheet');
                const handle  = document.getElementById('sheetHandleRow');
                const header  = document.querySelector('#resultSheet .sheet-header');
                if (!sheet) return;

                const SNAP = { PEEK: 0, MID: 1, FULL: 2 };
                const isDesktop = () => window.innerWidth >= 769;

                function snapH() {
                    const vh = window.innerHeight;
                    return [
                        Math.max(80, Math.round(vh * 0.115)), // PEEK ~88px
                        Math.round(vh * 0.46),                 // MID  46vh
                        Math.round(vh * 0.88),                 // FULL 88vh
                    ];
                }

                let currentSnap = SNAP.MID;
                let snapTimer   = null;

                function snapTo(idx, instant) {
                    if (isDesktop()) return;
                    idx = Math.max(SNAP.PEEK, Math.min(SNAP.FULL, idx));
                    currentSnap = idx;
                    sheet.dataset.snap = idx;
                    clearTimeout(snapTimer);

                    const h = snapH()[idx];
                    if (instant) {
                        sheet.classList.remove('is-snapping');
                        sheet.style.transition = 'none';
                        sheet.style.height = h + 'px';
                        void sheet.offsetHeight; // flush
                        sheet.style.transition = '';
                    } else {
                        sheet.classList.add('is-snapping');
                        sheet.style.height = h + 'px';
                        snapTimer = setTimeout(() => {
                            sheet.classList.remove('is-snapping');
                            try { if (leafletMap) leafletMap.invalidateSize(true); } catch(e) {}
                        }, 460);
                    }
                }

                // ── Drag state ──
                let active  = false;
                let startY  = 0, startH = 0;
                let lastY   = 0, lastT  = 0, vel = 0;

                function onStart(y) {
                    if (isDesktop()) return;
                    active = true;
                    startY = y; startH = sheet.offsetHeight;
                    lastY  = y; lastT  = performance.now(); vel = 0;
                    clearTimeout(snapTimer);
                    sheet.classList.remove('is-snapping');
                    sheet.style.transition = 'none';
                }

                function onMove(y) {
                    if (!active) return;
                    const now = performance.now();
                    const dt  = now - lastT;
                    if (dt > 0) vel = (lastY - y) / dt * 1000; // px/s positive=up
                    lastY = y; lastT = now;

                    const raw  = startH + (startY - y);
                    const minH = 48, maxH = window.innerHeight * 0.92;
                    const h = raw < minH ? minH + (raw - minH) * 0.18
                            : raw > maxH ? maxH + (raw - maxH) * 0.18
                            : raw;
                    sheet.style.height = Math.max(30, h) + 'px';
                }

                function onEnd() {
                    if (!active) return;
                    active = false;
                    const h       = sheet.offsetHeight;
                    const heights = snapH();
                    let target;

                    if      (vel >  700) target = Math.min(currentSnap + 1, SNAP.FULL);
                    else if (vel < -700) target = Math.max(currentSnap - 1, SNAP.PEEK);
                    else {
                        let best = 0, bestD = Infinity;
                        heights.forEach((sh, i) => { const d = Math.abs(h - sh); if (d < bestD) { bestD = d; best = i; } });
                        target = best;
                    }
                    snapTo(target);
                }

                // ── Attach to both handle and header (bigger touch target) ──
                const zones = [handle, header].filter(Boolean);
                zones.forEach(zone => {
                    zone.addEventListener('pointerdown', e => {
                        if (isDesktop()) return;
                        onStart(e.clientY);
                        try { zone.setPointerCapture(e.pointerId); } catch(_) {}
                        e.preventDefault();
                    }, { passive: false });
                    zone.addEventListener('pointermove', e => {
                        if (!active) return;
                        onMove(e.clientY);
                        e.preventDefault();
                    }, { passive: false });
                    zone.addEventListener('pointerup',     onEnd);
                    zone.addEventListener('pointercancel', () => { active = false; sheet.style.transition = ''; });

                    // Native touch (iOS Safari critical)
                    zone.addEventListener('touchstart', e => {
                        if (isDesktop()) return;
                        onStart(e.touches[0].clientY);
                    }, { passive: true });
                    zone.addEventListener('touchmove', e => {
                        if (!active) return;
                        e.preventDefault();
                        onMove(e.touches[0].clientY);
                    }, { passive: false });
                    zone.addEventListener('touchend',    onEnd);
                    zone.addEventListener('touchcancel', () => { active = false; });
                });

                // Tap on PEEK area → expand to MID
                sheet.addEventListener('click', () => {
                    if (!active && currentSnap === SNAP.PEEK) snapTo(SNAP.MID);
                });

                // Window resize: recalculate
                window.addEventListener('resize', () => {
                    if (!isDesktop()) snapTo(currentSnap, true);
                    else sheet.style.height = '';
                }, { passive: true });

                // Init to MID
                snapTo(SNAP.MID, true);

                // ── Public API ──
                window._sheet = { snapTo, SNAP, get current() { return currentSnap; } };
            })();

            // ── Desktop: drag-to-resize боковой панели по ширине ──
            (function initSheetWidthResize() {
                const sheet  = document.getElementById('resultSheet');
                const handle = document.getElementById('sheetResizeHandle');
                if (!sheet || !handle) return;

                const isDesktop = () => window.innerWidth >= 769;
                const MIN_W = 300;
                const maxW  = () => Math.min(760, Math.round(window.innerWidth * 0.9));
                const clamp = w => Math.max(MIN_W, Math.min(maxW(), w));

                // Восстановить сохранённую ширину
                const saved = parseInt(localStorage.getItem('sheetWidth'), 10);
                if (saved && isDesktop()) sheet.style.width = clamp(saved) + 'px';

                let active = false, startX = 0, startW = 0;

                function onMove(x) {
                    if (!active) return;
                    sheet.style.width = clamp(startW + (x - startX)) + 'px';
                }
                function onEnd() {
                    if (!active) return;
                    active = false;
                    document.body.classList.remove('sheet-resizing');
                    localStorage.setItem('sheetWidth', parseInt(sheet.style.width, 10) || 360);
                    try { if (leafletMap) leafletMap.invalidateSize(true); } catch (e) {}
                }

                handle.addEventListener('pointerdown', e => {
                    if (!isDesktop()) return;
                    active = true;
                    startX = e.clientX;
                    startW = sheet.offsetWidth;
                    document.body.classList.add('sheet-resizing');
                    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
                    e.preventDefault();
                }, { passive: false });
                handle.addEventListener('pointermove', e => {
                    if (!active) return;
                    onMove(e.clientX);
                    e.preventDefault();
                }, { passive: false });
                handle.addEventListener('pointerup', onEnd);
                handle.addEventListener('pointercancel', onEnd);
            })();
        };

        __tbReady(() => {
            try { window.__tbBoot(); } catch (e) { console.error('TravelBase boot', e); window.__tbBootError = String(e && e.stack || e); }
        });


// ─── Квиз подбора направления (POST /api/match-destinations) ───
const QUIZ_QUESTIONS = [
    {
        key: 'style', title: 'Какой у вас стиль путешествий?', subtitle: 'От темпа зависит подбор направления',
        options: [
            { value: 'active', icon: '🥾', label: 'Активный', note: 'горы, тропы, максимум впечатлений' },
            { value: 'calm', icon: '🌊', label: 'Спокойный', note: 'море, променады, расслабленный темп' },
            { value: 'mixed', icon: '⚖️', label: 'Смешанный', note: 'и активность, и отдых' },
        ],
    },
    {
        key: 'visa', title: 'Готовы ли оформлять визу?', subtitle: 'Учтём только реально доступные направления',
        options: [
            { value: 'any', icon: '🛂', label: 'Готов оформлять', note: 'виза не помеха' },
            { value: 'no-visa', icon: '✈️', label: 'Только безвиз', note: 'без визы или виза по прилёту' },
            { value: 'russia-only', icon: '🇷🇺', label: 'Только Россия', note: 'путешествуем внутри страны' },
        ],
    },
    {
        key: 'budget', title: 'Какой бюджет на поездку?', subtitle: 'На человека, без фанатизма',
        options: [
            { value: 'low', icon: '🎒', label: 'Эконом', note: 'хостелы, стритфуд, автобусы' },
            { value: 'mid', icon: '🏨', label: 'Средний', note: 'отель 3–4★, кафе, такси иногда' },
            { value: 'high', icon: '💎', label: 'Не важен', note: 'комфорт важнее цены' },
        ],
    },
    {
        key: 'month', title: 'Когда планируете поездку?', subtitle: 'Подберём сезон на месте', compact: true,
        options: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
            .map((m) => ({ value: m.toLowerCase(), icon: '🗓', label: m })),
    },
    {
        key: 'companions', title: 'С кем едете?', subtitle: 'Влияет на темп и логистику',
        options: [
            { value: 'solo', icon: '🧭', label: 'Один', note: 'свобода маршрута' },
            { value: 'couple', icon: '💑', label: 'Пара', note: 'романтика и уют' },
            { value: 'family', icon: '👨‍👩‍👧', label: 'С семьёй', note: 'дети, спокойная логистика' },
            { value: 'friends', icon: '🎉', label: 'С друзьями', note: 'компания и движ' },
        ],
    },
    {
        key: 'climate', title: 'Климат и перелёт', subtitle: 'Выберите климат, потом задайте лимит перелёта', withFlight: true,
        options: [
            { value: 'warm', icon: '☀️', label: 'Тепло', note: 'пляжи и лето круглый год' },
            { value: 'mild', icon: '🌤', label: 'Умеренно', note: 'комфортные прогулки' },
            { value: 'any', icon: '🌍', label: 'Неважно', note: 'главное — впечатления' },
        ],
    },
];
let quizStep = 0;
let quizAnswers = {};

function openQuiz() {
    quizStep = 0;
    quizAnswers = { flightHours: 0 };
    document.body.classList.add('quiz-mode');
    document.getElementById('quizResults')?.classList.add('hidden');
    document.getElementById('quizScreen')?.classList.remove('hidden');
    renderQuizQuestion();
    window.scrollTo({ top: 0, behavior: 'auto' });
}

function closeQuiz() {
    document.body.classList.remove('quiz-mode');
    document.getElementById('quizScreen')?.classList.add('hidden');
    document.getElementById('quizResults')?.classList.add('hidden');
    window.scrollTo({ top: 0, behavior: 'auto' });
}

function restartQuiz() {
    quizStep = 0;
    quizAnswers = { flightHours: 0 };
    document.getElementById('quizResults')?.classList.add('hidden');
    document.getElementById('quizScreen')?.classList.remove('hidden');
    renderQuizQuestion();
}

function quizPrev() {
    if (quizStep > 0) {
        quizStep -= 1;
        renderQuizQuestion();
    }
}

function renderQuizQuestion() {
    const q = QUIZ_QUESTIONS[quizStep];
    if (!q) return;
    const back = document.getElementById('quizBackBtn');
    if (back) back.style.visibility = quizStep === 0 ? 'hidden' : 'visible';
    const label = document.getElementById('quizProgressLabel');
    if (label) label.textContent = `Вопрос ${quizStep + 1} из ${QUIZ_QUESTIONS.length}`;
    const fill = document.getElementById('quizProgressFill');
    if (fill) fill.style.width = `${((quizStep + 1) / QUIZ_QUESTIONS.length) * 100}%`;
    const title = document.getElementById('quizTitle');
    if (title) title.textContent = q.title;
    const subtitle = document.getElementById('quizSubtitle');
    if (subtitle) subtitle.textContent = q.subtitle || '';

    const box = document.getElementById('quizOptions');
    if (box) {
        box.innerHTML = '';
        box.classList.toggle('quiz-options-compact', Boolean(q.compact));
        for (const opt of q.options) {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'quiz-option' + (quizAnswers[q.key] === opt.value ? ' is-selected' : '');
            el.innerHTML =
                (q.compact ? '' : `<span class="quiz-option-icon">${opt.icon}</span>`) +
                `<span class="quiz-option-body"><b>${opt.label}</b>` +
                (opt.note ? `<span class="quiz-option-note">${opt.note}</span>` : '') +
                '</span>';
            el.onclick = () => selectQuizOption(q, opt.value);
            box.appendChild(el);
        }
    }

    const flight = document.getElementById('quizFlightBlock');
    if (flight) {
        flight.classList.toggle('hidden', !q.withFlight || !quizAnswers.climate);
        const range = document.getElementById('quizFlightRange');
        if (range && q.withFlight && !range.dataset.quizBound) {
            range.dataset.quizBound = '1';
            range.addEventListener('input', () => {
                const v = Number(range.value) || 0;
                quizAnswers.flightHours = v;
                const out = document.getElementById('quizFlightValue');
                if (out) out.textContent = v === 0 ? 'не важно' : `до ${v} ч`;
            });
        }
    }
}

function selectQuizOption(q, value) {
    quizAnswers[q.key] = value;
    if (q.withFlight) {
        renderQuizQuestion(); // показываем блок перелёта
        return;
    }
    // Мгновенная визуальная обратная связь, затем следующий вопрос.
    const box = document.getElementById('quizOptions');
    box?.querySelectorAll('.quiz-option').forEach((el) => el.classList.remove('is-selected'));
    const idx = q.options.findIndex((o) => o.value === value);
    box?.children[idx]?.classList.add('is-selected');
    setTimeout(() => {
        quizStep = Math.min(quizStep + 1, QUIZ_QUESTIONS.length - 1);
        renderQuizQuestion();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 220);
}

async function submitQuiz() {
    const btn = document.getElementById('quizSubmitBtn');
    btn?.classList.add('is-loading');
    if (btn) btn.disabled = true;

    // Полноэкранный лоадер с честным N из базы знаний.
    document.getElementById('quizScreen')?.classList.add('hidden');
    document.body.classList.remove('quiz-mode');
    document.body.classList.add('loading-mode');
    const loading = document.getElementById('loading');
    if (loading) loading.classList.remove('hidden');
    const sub = document.querySelector('#loading .ls-subtitle-new');
    if (sub) sub.textContent = 'Сопоставляем ваши ответы с базой направлений...';
    fetch('/api/kb-stats')
        .then((r) => r.json())
        .then((s) => {
            const n = Number(s && s.kbPlaces) || 0;
            if (n > 0 && sub) sub.textContent = `Сопоставляем ваши ответы с базой из ${n} направлений...`;
        })
        .catch(() => {});
    if (typeof startLoadingAnimation === 'function') startLoadingAnimation();

    const finish = () => {
        if (loading) loading.classList.add('hidden');
        document.body.classList.remove('loading-mode');
        btn?.classList.remove('is-loading');
        if (btn) btn.disabled = false;
    };
    const backToQuiz = () => {
        finish();
        document.body.classList.add('quiz-mode');
        document.getElementById('quizScreen')?.classList.remove('hidden');
    };

    try {
        const resp = await fetch('/api/match-destinations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                style: quizAnswers.style || 'mixed',
                visa: quizAnswers.visa || 'any',
                budget: quizAnswers.budget || 'mid',
                month: quizAnswers.month || '',
                companions: quizAnswers.companions || 'couple',
                climate: quizAnswers.climate || 'any',
                flightHours: Number(quizAnswers.flightHours) || 0,
            }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.success || !Array.isArray(data.results) || !data.results.length) {
            throw new Error(data.error || 'Не удалось подобрать направления');
        }
        finish();
        document.body.classList.add('quiz-mode');
        renderQuizResults(data);
        document.getElementById('quizResults')?.classList.remove('hidden');
        window.scrollTo({ top: 0, behavior: 'auto' });
    } catch (e) {
        backToQuiz();
        const subtitle = document.getElementById('quizSubtitle');
        if (subtitle) subtitle.textContent = `⚠️ ${e.message}. Попробуйте ещё раз.`;
    }
}

const QUIZ_CRITERIA = [
    ['style', 'Стиль'], ['budget', 'Бюджет'], ['season', 'Сезон'],
    ['climate', 'Климат'], ['visa', 'Виза'], ['flight', 'Перелёт'],
];

function quizScoreCell(v) {
    const n = Number(v) || 0;
    return `<div class="quiz-score"><div class="quiz-score-bar"><i style="width:${n * 10}%"></i></div><span>${n}/10</span></div>`;
}

function renderQuizResults(data) {
    const results = data.results;
    const sub = document.getElementById('quizResultsSubtitle');
    if (sub) {
        const src = data.source === 'ai' ? 'оценка ИИ по базе знаний' : 'оценка по профилям направлений';
        sub.textContent = `${results.length} направления по вашей анкете · ${src}. Нажмите на направление, чтобы собрать маршрут.`;
    }

    // Десктоп: сравнительная таблица (колонка = направление).
    const tableWrap = document.getElementById('quizTableWrap');
    if (tableWrap) {
        let html = '<table class="quiz-table"><thead><tr><th></th>';
        for (const r of results) {
            html += `<th class="quiz-col-head" data-city="${r.city}" data-country="${r.country}" data-flag="${r.flag}">` +
                `<div class="quiz-col-flag">${r.flag}</div><b>${r.city}</b><span>${r.country}</span></th>`;
        }
        html += '</tr></thead><tbody>';
        html += '<tr class="quiz-row-match"><td>Совпадение</td>' +
            results.map((r) => `<td class="quiz-match-pct">${r.matchPercent}%</td>`).join('') + '</tr>';
        for (const [key, label] of QUIZ_CRITERIA) {
            html += `<tr><td>${label}</td>` +
                results.map((r) => `<td>${quizScoreCell(r.scores?.[key])}</td>`).join('') + '</tr>';
        }
        html += '<tr class="quiz-row-reason"><td></td>' +
            results.map((r) => `<td class="quiz-reason">${r.reason || ''}</td>`).join('') + '</tr>';
        html += '</tbody></table>';
        tableWrap.innerHTML = html;
        tableWrap.querySelectorAll('.quiz-col-head').forEach((th) => {
            th.onclick = () => chooseQuizDestination(th.dataset.city, th.dataset.country, th.dataset.flag);
        });
    }

    // Мобильный: карточки с полосой совпадения и аккордеоном деталей.
    const cards = document.getElementById('quizCards');
    if (cards) {
        cards.innerHTML = '';
        results.forEach((r, i) => {
            const card = document.createElement('div');
            card.className = 'quiz-card';
            card.innerHTML =
                `<div class="quiz-card-head" data-i="${i}">` +
                `<span class="quiz-card-flag">${r.flag}</span>` +
                `<div class="quiz-card-title"><b>${r.city}</b><span>${r.country}</span></div>` +
                `<div class="quiz-card-pct">${r.matchPercent}%</div></div>` +
                `<div class="quiz-match-bar"><i style="width:${r.matchPercent}%"></i></div>` +
                `<p class="quiz-reason">${r.reason || ''}</p>` +
                `<button type="button" class="quiz-card-more" data-i="${i}">Критерии ▾</button>` +
                `<div class="quiz-card-details hidden" id="quizCardDetails${i}">` +
                QUIZ_CRITERIA.map(([key, label]) =>
                    `<div class="quiz-card-crit"><span>${label}</span>${quizScoreCell(r.scores?.[key])}</div>`,
                ).join('') +
                `</div>` +
                `<button type="button" class="quiz-card-choose">Собрать маршрут →</button>`;
            card.querySelector('.quiz-card-more').onclick = (e) => {
                e.stopPropagation();
                const det = card.querySelector(`#quizCardDetails${i}`);
                det?.classList.toggle('hidden');
                e.target.textContent = det?.classList.contains('hidden') ? 'Критерии ▾' : 'Критерии ▴';
            };
            card.querySelector('.quiz-card-choose').onclick = () => chooseQuizDestination(r.city, r.country, r.flag);
            card.querySelector('.quiz-card-head').onclick = () => chooseQuizDestination(r.city, r.country, r.flag);
            cards.appendChild(card);
        });
    }
}

function chooseQuizDestination(city, country, flag) {
    selectUnifiedDestination(city, country, flag || '🌍');
    closeQuiz();
    // Главный экран с выбранным чипом; дальше пользователь жмёт «Собрать маршрут».
    window.scrollTo({ top: 0, behavior: 'smooth' });
}
