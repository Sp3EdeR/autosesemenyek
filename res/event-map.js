/** Converts either column labels or the events sheet's first-row headers into records. */
function sheetRecords(table, columns) {
    const hasLabels = table.cols.some(column => column.label);
    const names = table.cols.map((column, index) =>
        (hasLabels ? column.label : table.rows[0]?.c[index]?.v) || columns[index]);
    return table.rows.slice(hasLabels ? 0 : 1).map(row => Object.fromEntries(
        names.map((name, index) => [name, row.c?.[index]?.v ?? null])));
}

/** Joins normalized location names and rejects missing coordinates or malformed intervals. */
function geocodedEvents(eventsTable, locationsTable) {
    const locations = new Map();
    const records = sheetRecords(locationsTable, ['locname', 'lat', 'lng']);
    const normalizeLocation = name => typeof name == 'string' ? name.trim().toLowerCase() : '';

    // Load location records into a map
    for (const location of records) {
        const name = normalizeLocation(location.locname);
        const { lat, lng } = location;
        if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 &&
            Math.abs(lng) <= 180 && name)
            locations.set(name, [lat, lng]);
    }

    // Load events in database with location coordinates
    // Drop events with missing location or geocoding data
    const columns = ['start', 'end', 'summary', 'location', 'description', 'calendarId'];
    return sheetRecords(eventsTable, columns).flatMap(event => {
        const name = normalizeLocation(event.location);
        if (!name)
            return [];
        if (!locations.has(name)) {
            console.warn(`No geocoding entry found for event location: ${event.location}!`);
            return [];
        }
        const coordinates = locations.get(name);
        const start = Date.parse(event.start), end = Date.parse(event.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
            console.warn(`Invalid event interval for event: ${event.summary}!`);
            return [];
        }
        return [{ ...event, calendarId: event[Object.keys(event)[5]], start, end, coordinates }];
    });
}

/** Extends Leaflet's Canvas renderer to draw custom 12px event pins. */
const CanvasPinRenderer = L.Canvas.extend({
    _updateCircle(pin) {
        if (!this._drawing || pin._empty())
            return;
        const context = this._ctx;
        const { x, y } = pin._point;
        context.beginPath();
        context.moveTo(x, y + 6);
        context.bezierCurveTo(x - 2, y + 3, x - 4, y, x - 4, y - 2);
        context.arc(x, y - 2, 4, Math.PI, 0);
        context.bezierCurveTo(x + 4, y, x + 2, y + 3, x, y + 6);
        context.closePath();
        this._fillStroke(context, pin);
    }
});

/** Extends Leaflet's CircleMarker to create custom event pins with adjusted projection and popup anchor. */
const CanvasPin = L.CircleMarker.extend({
    _project() {
        L.CircleMarker.prototype._project.call(this);
        this._point.y -= 6;
        this._updateBounds();
    },
    _getPopupAnchor() {
        return [0, -12];
    }
});

/** Displays geocoded events inside the calendar iframe using huroutes' Leaflet setup. */
class EventMap {
    /** Creates map controls immediately; only this iframe requests event and geocoding data. */
    constructor() {
        this._calendars = new Map();
        this._events = [];
        this._map = L.map('map', { zoomControl: false })
            .fitBounds([[48.509, 15.659], [45.742, 23.193]]);
        this._map.createPane('eventDotPane').classList.add('event-dot-pane');
        this._dotRenderer = new CanvasPinRenderer({ pane: 'eventDotPane', tolerance: 10 });
        this._markers = L.layerGroup().addTo(this._map);
        this._map.on('zoomend', () => {
            if (this._usingDots != (this._map.getZoom() < 10))
                this._render();
            else
                this._updateLabels();
        });
        this._map.on('moveend', () => this._updateLabels());
        this._map.on('resize', () => this._markers.eachLayer(m => m.getPopup().update()));
        this._status = document.getElementById('map-status');
        this._initLayers();
        this._initLocation();

        this._initDates();

        // Update the dark/light theme now and on changes
        const theme = matchMedia('(prefers-color-scheme: dark)');
        const updateTheme = () => {
            document.documentElement.classList.toggle('theme-dark', theme.matches);
            document.documentElement.classList.toggle('theme-light', !theme.matches);
            // Black border always, but map colour inversion must be corrected
            this._dotBorderColor = theme.matches ? '#fff' : '#000';
            if (this._usingDots)
                this._markers.eachLayer(dot => dot.setStyle({ color: this._dotBorderColor }));
        };
        theme.addEventListener('change', updateTheme);
        updateTheme();

        // Handle the calendar subscription link in the parent page
        document.getElementById('map-subscribe').addEventListener('click', event => {
            event.preventDefault();
            parent.calendars.openSubscription();
        });

        this._load();
    }

    /** Matches huroutes' base layers, optional overlays, and satellite-only road overlay. */
    _initLayers() {
        const google = (type, className) => L.tileLayer(
            `https://{s}.google.com/vt/lyrs=${type}&x={x}&y={y}&z={z}`, {
                attribution: '&copy; Google Maps', minZoom: 5, maxZoom: 18,
                subdomains: ['mt0', 'mt1', 'mt2', 'mt3'], className
            });
        const tourist = (url, className, zIndex) => L.tileLayer(url, {
            attribution: '&copy; turistautak.hu', minZoom: 5, maxZoom: 18, className, zIndex
        });
        const tiles = {
            Map: L.tileLayer.provider('OpenStreetMap', { className: 'tile-openstreetmap' }),
            Terrain: L.tileLayer.provider('OpenTopoMap', { className: 'tile-opentopomap' }),
            Satellite: L.tileLayer.provider('Esri.WorldImagery', { className: 'tile-satellite' }),
            'Google Map': google('m', 'tile-googlemap'),
            'Google Terrain': google('p', 'tile-googleterrain'),
            'Google Satellite': google('s,h', 'tile-googlesatellite')
        };
        const overlays = {
            'Elevation Shading': tourist(
                'https://map.turistautak.hu/tiles/shading/{z}/{x}/{y}.png', 'overlay-dem', 5),
            Turistautak: tourist('https://{s}.tile.openstreetmap.hu/tt/{z}/{x}/{y}.png',
                'overlay-turistautak', 100)
        };
        const roads = tourist('https://map.turistautak.hu/tiles/lines/{z}/{x}/{y}.png',
            'overlay-satelliteroads', 10);
        const labels = {
            Map: 'Térkép', Terrain: 'Domborzat', Satellite: 'Műhold',
            'Google Map': 'Google Térkép', 'Google Terrain': 'Google Domborzat',
            'Google Satellite': 'Google Műhold', 'Elevation Shading': 'Domborzat Kiemelés'
        };
        const localized = layers => Object.fromEntries(Object.entries(layers)
            .map(([id, layer]) => {
                layer.id = id;
                return [labels[id] || id, layer];
            }));

        // Initialize map controls
        L.control.layers(localized(tiles), localized(overlays), { position: 'bottomleft' })
            .addTo(this._map);
        L.control.scale({ position: 'bottomright', imperial: false }).addTo(this._map);
        L.control.zoom({ position: 'bottomright', zoomInTitle: 'Térkép nagyítása',
            zoomOutTitle: 'Térkép kicsinyítése' }).addTo(this._map);
        const attribution = this._map.attributionControl.getContainer();
        new ResizeObserver(() => this._map.getContainer().style
            .setProperty('--attribution-height', attribution.offsetHeight + 'px'))
            .observe(attribution);

        // Load the user's preferred base layer
        const selected = localStorage.eventMapStyle || 'Map';
        (tiles[selected] || tiles.Map).addTo(this._map);

        // Automatically show roads for the satellite layer
        if (selected == 'Satellite')
            roads.addTo(this._map);
        this._map.on('baselayerchange', event => {
            localStorage.eventMapStyle = event.layer.id;
            if (event.layer.id == 'Satellite')
                roads.addTo(this._map);
            else
                roads.remove();
        });

        // Load and persist map overlays
        for (const id of (localStorage.eventMapOverlays || '').split('|'))
            overlays[id]?.addTo(this._map);
        this._map.on('overlayadd overlayremove', () => {
            localStorage.eventMapOverlays = Object.keys(overlays)
                .filter(id => this._map.hasLayer(overlays[id])).join('|');
        });
    }

    /** Uses huroutes' high-accuracy location control and stops following after pan or zoom. */
    _initLocation() {
        const control = L.control.locate({
            cacheLocation: false,
            clickBehavior: { inView: 'stop', outOfView: 'setView', inViewNotFollowing: 'setView' },
            initialZoomLevel: 16, keepCurrentZoomLevel: true, position: 'bottomright',
            flyTo: true, locateOptions: { enableHighAccuracy: true },
            setView: 'untilPanOrZoom', showPopup: false,
            strings: { title: 'Az aktuális pozícióm mutatása.' },
            onLocationError: () => {
                this._status.textContent = 'A helyzeted nem határozható meg.';
                localStorage.removeItem('eventMapLocation');
            }
        }).addTo(this._map);
        this._map.on('locateactivate', () => localStorage.eventMapLocation = 'true');
        this._map.on('locatedeactivate', () => localStorage.removeItem('eventMapLocation'));
        if (localStorage.eventMapLocation) {
            control.options.setView = false;
            control.start();
            control.options.setView = 'untilPanOrZoom';
            try {
                control.stopFollowing();
            } catch { }
        }
    }

    /** Keeps empty start at now and empty end unbounded; end dates are inclusive. */
    _initDates() {
        this._start = document.getElementById('date-start');
        this._end = document.getElementById('date-end');

        // Native picker action labels follow browser settings rather than the page language.
        flatpickr([this._start, this._end], {
            locale: 'hu',
            dateFormat: 'Y-m-d',
            altInput: true,
            altFormat: 'Y. m. d.',
            allowInput: true,
            disableMobile: true,
            static: true,
            onReady: (dates, value, picker) => {
                // Add "clear" and "today" buttons to the panel
                picker.altInput.id = picker.input.id + '-display';
                const actions = document.createElement('div');
                actions.className = 'date-actions';
                for (const [label, action] of [
                    ['Törlés', () => picker.clear()],
                    ['Ma', () => picker.setDate(new Date(), true)]
                ]) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.textContent = label;
                    button.addEventListener('click', () => { action(); picker.close(); });
                    actions.append(button);
                }
                picker.calendarContainer.append(actions);
            }
        });

        const filter = document.getElementById('date-filter');
        const form = document.getElementById('date-form');

        // Prevent the default form submission and handle reset manually.
        form.addEventListener('submit', event => event.preventDefault());
        form.addEventListener('reset', event => {
            event.preventDefault();
            this._start._flatpickr.clear(false);
            endPicker.clear(false);
            endPicker.set('minDate', null);
            endPicker.altInput.setCustomValidity('');
            filter.open = false;
            this._render();
        });

        // Limit the end time picker to dates after the start date.
        const endPicker = this._end._flatpickr;
        form.addEventListener('change', () => {
            const reversed = this._end.value && this._start.value > this._end.value;
            endPicker.altInput.setCustomValidity(reversed ?
                'A záródátum nem előzheti meg a kezdődátumot.' : '');
            if (!form.reportValidity())
                return;
            endPicker.set('minDate', this._start.value || null);
            this._render();
        });

        // Close the filter when clicking outside of it or pressing Escape.
        const closeFilter = () => {
            filter.open = false;
            this._start._flatpickr.close();
            endPicker.close();
        };
        document.addEventListener('pointerdown', event => {
            if (!filter.querySelector('summary').contains(event.target) &&
                !form.contains(event.target))
                closeFilter();
        });
        // Pointer events do not cross iframe boundaries; clean up on iframe navigation.
        parent.document.addEventListener('pointerdown', closeFilter, true);
        window.addEventListener('pagehide', () =>
            parent.document.removeEventListener('pointerdown', closeFilter, true));
        window.addEventListener('pageshow', event => {
            if (event.persisted)
                parent.document.addEventListener('pointerdown', closeFilter, true);
        });
        document.addEventListener('keydown', event => {
            if (event.key == 'Escape')
                closeFilter();
        });
    }

    /** Loads cached tables from the parent. */
    async _load() {
        this._status.textContent = 'Események betöltése...';
        try {
            const tables = await parent.calendars.loadMapData();
            this._events = geocodedEvents(...tables).sort((a, b) => a.start - b.start);
            this._loaded = true;
            this._render();
        } catch (error) {
            console.error('Failed to load event map.', error);
            this._status.textContent = 'Az események betöltése sikertelen.';
        }
    }

    /** Receives only the active page's selected calendar IDs, including Celica Club calendars. */
    setCalendars(calendars) {
        this._calendars = new Map(calendars.map(calendar => [calendar.id, calendar.clr]));
        this._render();
    }

    /** Groups collocated events to avoid hidden markers and applies interval-overlap filtering. */
    _render() {
        // Update the date filter button's text
        const formatDate = value => new Date(value + 'T00:00:00').toLocaleDateString('hu-HU');
        document.getElementById('date-range').textContent =
            (this._start.value ? formatDate(this._start.value) : 'Mostantól') + ' \u2013 ' +
            (this._end.value ? formatDate(this._end.value) : 'Nincs záródátum');

        if (!this._loaded)
            return;

        // Calculate date filter time range
        const start = this._start.value ? new Date(this._start.value + 'T00:00:00').getTime() :
            Date.now();
        const endDate = this._end.value ? new Date(this._end.value + 'T00:00:00') : null;
        // Advance a calendar day to preserve inclusive ends through daylight saving changes.
        endDate?.setDate(endDate.getDate() + 1);
        const end = endDate?.getTime() ?? Infinity;

        // Group events by their coordinates to handle collocated events
        const groups = new Map();
        let count = 0;
        for (const event of this._events) {
            if (!this._calendars.has(event.calendarId) || event.end <= start ||
                event.start >= end)
                continue;
            const key = event.coordinates.join(',');
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push(event);
            ++count;
        }

        // Refresh map markers
        const usingDots = this._map.getZoom() < 10;
        const openMarker = this._usingDots != usingDots ?
            this._markers.getLayers().find(marker => marker.isPopupOpen()) : null;
        const openLocation = openMarker?.getLatLng();
        const scrollTop = openMarker?.getPopup().getElement()
            ?.querySelector('.event-details')?.scrollTop ?? 0;
        let replacement;
        this._usingDots = usingDots;
        this._markers.clearLayers();
        for (const events of groups.values()) {
            const calendars = [...new Set(events.map(event => event.calendarId))];
            const colors = calendars.map(id => this._calendars.get(id));
            let marker;
            if (this._usingDots) {
                // Draw pins onto the canvas at high zoom levels for performance
                const color = colors.length > 1 ? '#' + [1, 3, 5].map(offset =>
                    Math.round(colors.reduce((sum, color) =>
                        sum + parseInt(color.slice(offset, offset + 2), 16), 0) / colors.length)
                        .toString(16).padStart(2, '0')).join('') : colors[0];
                marker = new CanvasPin(events[0].coordinates, {
                    renderer: this._dotRenderer, radius: 6,
                    color: this._dotBorderColor, weight: 0.5, opacity: 1,
                    stroke: true, fillColor: color, fillOpacity: 1
                });
            } else {
                // Overlay DOM Pins at low zoom levels for better interactivity
                const icon = L.divIcon({
                    className: 'event-marker',
                    iconSize: [24, 30],
                    iconAnchor: [12, 30],
                    popupAnchor: [0, -26],
                    html: `<i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${
                        events.length > 1 ? `<span class="event-count">${events.length}</span>` : ''
                    }`
                });
                marker = L.marker(events[0].coordinates, { icon, title: events[0].location });
                const stops = colors.map((color, index) =>
                    color + (index == 0 ? ' 25%' : index == colors.length - 1 ? ' 90%' : ''));
                const color = colors.length > 1
                    ? `linear-gradient(135deg, ${stops.join(', ')})`
                    : colors[0];
                marker.on('add', () => marker.getElement().style.setProperty('--event-color', color));
            }
            marker.eventSummary = events.length == 1 ? events[0].summary : null;
            marker.bindPopup(() => this._popup(events), {
                className: 'event-popup', maxWidth: 550, minWidth: 220
            });

            this._markers.addLayer(marker);
            if (openLocation && marker.getLatLng().equals(openLocation))
                replacement = marker;
        }
        if (replacement) {
            const popup = replacement.getPopup();
            const autoPan = popup.options.autoPan;
            popup.options.autoPan = false;
            replacement.openPopup();
            popup.getElement().querySelector('.event-details').scrollTop = scrollTop;
            popup.options.autoPan = autoPan;
        }
        this._updateLabels();
        this._status.textContent = `${count} esemény · ${groups.size} helyszín`;
    }

    /** Allocates labels only for visible single-event pins at town zoom or closer. */
    _updateLabels() {
        const closeZoom = this._map.getZoom() >= 10;
        const bounds = this._map.getBounds();
        this._markers.eachLayer(marker => {
            const show = closeZoom && marker.eventSummary && bounds.contains(marker.getLatLng());
            if (show && !marker.getTooltip()) {
                const label = document.createElement('span');
                label.textContent = marker.eventSummary;
                marker.bindTooltip(label, {
                    permanent: true,
                    direction: 'bottom',
                    offset: [0, -5],
                    className: 'event-label',
                    interactive: false
                });
            } else if (!show && marker.getTooltip()) {
                marker.unbindTooltip();
            }
        });
    }

    /** Builds icon-aligned details with safe Maps/source links and Budapest times. */
    _popup(events) {
        const container = $('<div>', { class: 'event-details' });
        const date = new Intl.DateTimeFormat('hu-HU', {
            dateStyle: 'long',
            timeStyle: 'short',
            timeZone: 'Europe/Budapest'
        });
        for (const event of events) {
            const locHref = new URL('https://maps.google.com/maps');
            locHref.search = new URLSearchParams({ q: event.location, source: 'calendar' }).toString();

            const details = $(`
<section style="--event-color: ${this._calendars.get(event.calendarId)};">
  <span class="event-calendar-color" aria-hidden="true"></span>
  <h2>summary</h2>
  <p class="event-time">${date.format(event.start)} &ndash; ${date.format(event.end)}</p>
  <a class="event-location" href="${locHref.href}" target="_blank" rel="noopener noreferrer">
    <i class="fa-solid fa-location-dot"></i> <span>location</span>
  </a>
  <i class="fa-solid fa-align-left"></i> <div class="event-description"></div>
</section>
`);

            details.find('h2').text(event.summary);
            details.find('.event-location span').text(event.location);
            const description = details.find('.event-description').html(
                DOMPurify.sanitize(event.description || '', {
                    ALLOWED_TAGS: ['a', 'p', 'br', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em'],
                    ALLOWED_ATTR: ['href', 'title']
                }));
            description.find('a').attr({ target: '_blank', rel: 'noopener noreferrer' });

            details.appendTo(container);
        }
        return container[0];
    }
}

window.eventMap = new EventMap();
