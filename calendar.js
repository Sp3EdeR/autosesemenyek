/* Usage: Place the script into an empty div:
 * <script src="calendar.js" id="calendar-script"></script>
 * <script>
 *   calendars.init({ ... });
 * </script>
 * Where the init function takes:
 * { 'calendar-name': {'url': 'url-fragment', 'clr': '#clrcode'}, ... }
 */

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
            tab.click(() => this.select(id));
        });

        var selectedId = 'tab-controller-AGENDA';
        if (pageStorage.getItem('tabId') && container.find('#' + selectedId).length)
            selectedId = pageStorage.getItem('tabId');
        this.select(selectedId);
    }
    select(id) {
        if (this.selectedId == id)
            return;
        this.selectedId = id;
        pageStorage.setItem('tabId', id);

        var shortId = id.replace('tab-controller-', '');
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

const calendars = new class Calendars {
    constructor() {
        this._container = $('#calendar-script').parent();
        this._container.append($(`
<iframe style="border: 0" width="100%" height="600" frameborder="0" scrolling="no"></iframe>
<div class="controls-calendar-view">
  <button class="dropdown-toggle" type="button" id="viewButton" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false" tabindex="1">
    <span class="button-face" data-mode="AGENDA"><i class="fa-solid fa-bars button-short"></i><span class="button-long">Ütemezés</span></span>
    <span class="button-face d-none" data-mode="WEEK"><i class="fa-solid fa-table-columns button-short"></i><span class="button-long">Hét</span></span>
    <span class="button-face d-none" data-mode="MONTH"><i class="fa-solid fa-table button-short"></i><span class="button-long">Hónap</span></span>
  </button>
  <div class="dropdown-menu dropdown-menu-right" aria-labelledby="viewButton">
    <a class="dropdown-item" href="#" id="tab-controller-AGENDA"><i class="fa-solid fa-bars mr-2"></i>Ütemezés</a>
    <a class="dropdown-item" href="#" id="tab-controller-WEEK"><i class="fa-solid fa-table-columns mr-2"></i>Hét</a>
    <a class="dropdown-item" href="#" id="tab-controller-MONTH"><i class="fa-solid fa-table mr-2"></i>Hónap</a>
  </div>
</div>
<p class="controls-calendar-switches"></p>
`));

        this._calendarContainer = this._container.children('iframe').first();
        this._switchesContainer = this._container.children('.controls-calendar-switches').first();
        this._urlBase =
            'https://calendar.google.com/calendar/u/0/embed?height=600&wkst=2&bgcolor=%23eef1f8' +
            '&ctz=Europe%2FBudapest&showTz=0&showPrint=0&showDate=1&showTabs=0&showCalendars=0' +
            '&showTitle=0';

        this.tabs = new CalendarTabs(this._container.children('.controls-calendar-view').first());
        this.tabs.onTabChanged(() => this.update());
    }
    init(data) {
        this._switches = [];
        for (const [name, props] of Object.entries(data)) {
            const id = Calendars._normName(name);
            var isEnabled = pageStorage.getItem(id) == null ?
                props.on != false :
                pageStorage.getItem(id) == 'true';

            const ctrl = $(`<div class="custom-control custom-switch mr-sm-2"${props.hidden ? ' style="display: none"' : ''}>` +
                `<input type="checkbox" class="custom-control-input" id="${id}" value="${props.url}" ${isEnabled ? 'checked' : ''}>` +
                `<label class="custom-control-label" for="${id}" style="color: ${props.clr}">${name}</label>` +
                '</div>');
            this._switches.push(ctrl.children('input').on('change', event => {
                pageStorage.setItem(id, $(event.target).prop('checked'));
                this.update();
            }));
            this._switchesContainer.append(ctrl);
        }
        if (this._switches.length <= 1)
            this._switchesContainer.css('display', 'none');
        this._switchesContainer.addClass(['form-check', 'form-check-inline']);
        this.update();
    }
    update() {
        var options = '&mode=' + this.tabs.currentMode;
        options = this._switches.reduce(
            (accumulator, ctrl) =>
                ctrl.prop('checked') ? accumulator + ctrl.attr('value') : accumulator
            , options);
        this._calendarContainer.attr('src', this._urlBase + options);
    }
    static _normName(name) {
        return name.toLowerCase().replaceAll(' ', '');
    }
};
