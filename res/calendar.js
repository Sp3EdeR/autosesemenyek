/* Usage: Place the script into an empty div, where you want the calendar to be shown:
 * <script>
 *   calendars.init({ ... });
 * </script>
 * Where the init function takes:
 * { 'calendar-name': {'url': 'url-fragment', 'clr': '#clrcode'}, ... }
 */

const calendars = {
    init: null,
    openSubscription: null,
    startTour: null
};

(function() {

const pageStorage = new class {
    constructor() {
        this._namespace = location.pathname.replace(/^\/(.*?)\/?(?:index.html)?$/, '$1');
    }
    getItem(name) { return localStorage.getItem(this._namespace + name); }
    setItem(name, value) { return localStorage.setItem(this._namespace + name, value); }
    removeItem(name) { return localStorage.removeItem(this._namespace + name); }
};

class CalendarTabs {
    constructor(container) {
        this._container = container;
        this._button = container.find('button').first();
        this._button_faces = this._button.find('.button-face');
        this._tabs = container.find('.dropdown-item');
        this._each(tab => {
            const id = tab.attr('id');
            tab.click(event => {
                event.preventDefault();
                this._select(id);
            });
        });

        let selectedId = pageStorage.getItem('tabId');
        if (!selectedId || !container.find('#' + selectedId).length)
            selectedId = 'tab-controller-AGENDA';
        this._select(selectedId);
    }
    _select(id) {
        if (this.selectedId == id)
            return;
        this.selectedId = id;
        pageStorage.setItem('tabId', id);

        let shortId = id.replace('tab-controller-', '');
        this._button_faces.each(function() {
            $(this).toggleClass('d-none', $(this).attr('data-mode') != shortId);
        });

        if (this._onTabChanged)
            this._onTabChanged(shortId);
    }
    onTabChanged(onTabChanged) { this._onTabChanged = onTabChanged; }
    get currentMode() { return this.selectedId.replace('tab-controller-', ''); }
    _each(callback) {
        this._tabs.each(function () { callback($(this)); });
        return this;
    }
}

class CalendarStats {
    constructor() {
        this.initialized = false;
        this._updateStats();
    }
    onStatsLoaded(onStatsLoaded) { this._onStatsLoaded = onStatsLoaded; }
    _updateStats() {
        $.ajax("https://sp3eder.github.io/autosesemenyek-meta/stats.json", { dataType: "json" })
            .done(stats => {
                Object.assign(this, stats);
                this.initialized = true;
                if (this._onStatsLoaded)
                    this._onStatsLoaded(this);
            });
        setTimeout(() => this._updateStats(), 1000 * 60 * 5);
    }
}

class CalendarSwitches {
    constructor(container) {
        this._switchContainer = container.find('.controls-calendar-switches');
        const toggle = container.find('[data-bs-toggle="collapse"][href="#calendar-switches"]');
        this._caretUp = toggle.find('.fa-caret-up');
        this._caretDown = toggle.find('.fa-caret-down');
        this._updateCallback = null;
        this._switchContainer.on('change', event => {
            const switchCtrl = $(event.target);
            const id = switchCtrl.attr('id');
            pageStorage.setItem(id, switchCtrl.prop('checked'));
            this._updateCallback?.();
        });

        this._switchContainer.on('show.bs.collapse', () => {
            this._syncCaretState(true);
        });
        this._switchContainer.on('hide.bs.collapse', () => {
            this._syncCaretState(false);
        });
    }

    init(data) {
        this._data = data;

        for (const [name, props] of Object.entries(data)) {
            const id = name.toLowerCase().replaceAll(' ', '');
            let isEnabled = pageStorage.getItem(id) == null ?
                props.on != false :
                pageStorage.getItem(id) == 'true';

            this._switchContainer.append($(`
<div class="form-check form-switch d-inline-block">
  <input type="checkbox" role="switch" switch class="form-check-input" id="${id}" value="${name}" ${isEnabled ? 'checked' : ''}>
  <label class="form-check-label" for="${id}" style="color: ${props.clr}">${name}</label>
</div>
`));
        }
        this._switches = this._switchContainer.find('input');
        if (this._switches.length)
            this._switchContainer.removeClass('d-none');

        this._updateCollapse();
        $(window).on('resize', () => this._updateCollapse());

        this._updateCallback?.();
    }

    get selected() {
        return this._switches.filter(':checked').get().map(ctrl => this._data[ctrl.value]);
    }

    onUpdate(onUpdate) { this._updateCallback = onUpdate; }

    _updateCollapse() {
        const expand = 576 <= $(window).width();
        if (this._expanded === expand)
            return;

        this._switchContainer.toggleClass('show', expand);
        this._syncCaretState(expand);
        this._expanded = expand;
    }

    _syncCaretState(isExpanded) {
        this._caretUp.toggleClass('d-none', isExpanded);
        this._caretDown.toggleClass('d-none', !isExpanded);
    }
}

class Calendars {
    constructor(location, data) {
        this._container = $(location).parent();
        this._container.append($(`
<div class="calendar-frame-container position-relative">
  <iframe title="Naptár" class="d-block overflow-hidden m-0">Naptár betöltése...</iframe>
  <div class="date-tour-helper"></div>
  <div class="feedback-cover"></div>
  <div class="controls-calendar-view">
      <button class="dropdown-toggle" type="button" id="viewButton" data-bs-toggle="dropdown" aria-expanded="false" tabindex="1">
        <span class="button-face" data-mode="AGENDA"><i class="fa-solid fa-bars button-short"></i><span class="button-long">Ütemezés</span></span>
        <span class="button-face d-none" data-mode="MONTH"><i class="fa-solid fa-table button-short"></i><span class="button-long">Hónap</span></span>
      </button>
      <div class="dropdown-menu dropdown-menu-end" aria-labelledby="viewButton">
      <a class="dropdown-item" href="#" id="tab-controller-AGENDA"><i class="fa-solid fa-bars me-2"></i>Ütemezés</a>
      <a class="dropdown-item" href="#" id="tab-controller-MONTH"><i class="fa-solid fa-table me-2"></i>Hónap</a>
    </div>
  </div>
  <div class="controls-calendar-count rounded-circle" id="eventsCount"></div>
</div>
<div id="calendar-switch-container">
  <a class="d-block d-sm-none btn p-0" role="button" data-bs-toggle="collapse" href="#calendar-switches" aria-expanded="false" aria-controls="calendar-switches">
    <i class="fa-solid fa-caret-up"></i><i class="fa-solid fa-caret-down d-none"></i>
  </a>
  <div class="controls-calendar-switches collapse d-none p-0 mx-0 mt-2 mt-sm-0" id="calendar-switches"></div>
</div>
`));

        this._calendarFrame = this._container.find('iframe').first();
        this._urlBase =
            'https://calendar.google.com/calendar/u/0/embed?height=600&wkst=2&bgcolor=%23eef1f8' +
            '&ctz=Europe%2FBudapest&showTz=0&showPrint=0&showDate=1&showTabs=0&showCalendars=0' +
            '&showTitle=0';

        this._tabs = new CalendarTabs(this._container.find('.controls-calendar-view').first());
        this._tabs.onTabChanged(() => this._update());

        this._stats = new CalendarStats();
        this._stats.onStatsLoaded(() => this._updateStats());

        this._switches = new CalendarSwitches(this._container.find('div:has(>.controls-calendar-switches)'));
        this._switches.onUpdate(() => this._update());
        this._switches.init(data);
    }
    openSubscription() {
        let calIds = this._getSelectedCalIds();
        if (calIds.length == 0)
            return;
        window.open('https://calendar.google.com/calendar/r?cid=' + calIds.join('&cid='));
    }
    _update() {
        this._selectedCalData = this._switches.selected;

        let options = '&mode=' + this._tabs.currentMode;
        options = this._selectedCalData.reduce(
            (accumul, data) => accumul + Calendars._makeUrl(data.cals), options);
        this._calendarFrame.attr('src', this._urlBase + options);

        this._updateStats();
    }
    _updateStats() {
        if (!this._stats.initialized || !this._selectedCalData)
            return;
        const calIds = this._selectedCalData.map(d => d.cals).flat().map(c => c.id);
        const eventCount = calIds.reduce(
            (accumul, id) => accumul + (this._stats[id] ?? 0), 0);
        $('#eventsCount').html(`&raquo; ${eventCount} esemény`);
    }
    _getSelectedCalIds() {
        return this._selectedCalData.map(d => d.cals).flat().map(c => c.id);
    }
    static _makeUrl(calendarsData) {
        return Array.from(calendarsData, cal => `&src=${encodeURIComponent(cal.id)}&color=${encodeURIComponent(cal.clr)}`).join('')
    }
};

var _calendars = null;
calendars.init = data => { _calendars = new Calendars(document.currentScript, data); };
calendars.openSubscription = () => { _calendars?.openSubscription(); };
calendars.startTour = () => {
    const offcanvasElem = $('#menu .offcanvas');
    const offcanvas = bootstrap.Offcanvas.getOrCreateInstance(offcanvasElem);
    offcanvas.hide();

    const newEventSelector = '#menu button:has(.fa-calendar-plus)';
    const tour = introJs.tour().setOptions({
        steps: [
            { element: '.date-tour-helper', title: 'Dátumválasztó', intro: 'Itt válthatsz másik dátum megjelenítésére.' },
            { element: '.controls-calendar-view > button', title: 'Naptár Nézete', intro: 'Itt változtathatod meg a naptár nézetét.' },
            { element: '.calendar-frame-container', title: 'Esemény Részletei', intro: 'Kattints egy eseményre, hogy további információkat olvashass róla.' },
            { element: '#calendar-switch-container', title: 'Esemény Típus Szűrők', intro: 'Itt jeleníthetsz meg vagy rejthetsz el esemény típusokat.' },
            { title: 'Google Naptárba Vétel', intro: 'Nem muszáj mindig ide látogatnod, <a href="#" onclick="calendars.openSubscription(); event.preventDefault();">kattints ide</a>, hogy a Google Naptáradból is követhesd az eseményeket.' },
            { element: newEventSelector, title: 'Új Esemény', intro: 'Kattints ide, hogy új eseményt felvételést javasold nekünk.' }
        ].filter(step => !step.element || $(step.element).length),
        language: 'hu-HU',
        nextLabel: 'Tovább',
        prevLabel: 'Vissza',
        doneLabel: 'Kész'
    });
    const newEventButton = document.querySelector(newEventSelector);
    tour.onchange(targetElement => {
        if (targetElement === newEventButton && window.innerWidth <= offcanvasElem.offset().left)
            offcanvas.show();
        else
            offcanvas.hide();
    });
    tour.onStart(() => offcanvasElem.on('shown.bs.offcanvas', () => tour?.refresh()));
    tour.onExit(() => offcanvasElem.off('shown.bs.offcanvas'));
    tour.start();
};

// Hide popups when clicking into the iframe, or away from the tab
$(window).on('blur', () => $('.dropdown-toggle').dropdown('hide'));

// Samsung Browser forced dark mode workaround
if (navigator.userAgent.match(/SamsungBrowser/)) {
    // Detect forced dark mode by rendering a white image and checking pixel color
    const img = new Image();
    img.onload = function() {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.drawImage(img, 0, 0);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        if ((r & b & g) < 255)
            $('body').addClass('browser-forced-dark-mode');
    };
    img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMSIgaGVpZ2h0PSIxIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiIGZpbGw9IndoaXRlIi8+PC9zdmc+';
}

})();

// Test function to check app view
function toggleFullscreen() {
    $('html').toggleClass('fullscreen');
}
