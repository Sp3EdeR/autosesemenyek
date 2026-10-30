/** Explicit, cached Nominatim searches, serialized within the page. */
class EventMapGeocoder {
    static Providers = {
        primary: 'https://nominatim.openstreetmap.org/search',
        fallback: 'https://api.nominatim.terravo.eu/search'
    };

    constructor() {
        this._queue = Promise.resolve();
        this._lastRequestTime = 0;
    }

    async search(query) {
        query = query.trim();
        const key = query.toLocaleLowerCase('hu-HU');
        const cached = this._readCache()[key];
        const weekDuration = 7 * 24 * 60 * 60 * 1000;
        if (cached && Date.now() - cached.time < weekDuration)
            return cached.results;

        // Resolves the address and updates the cache (max 30 items)
        const search = async () => {
            let results;
            try {
                results = await this._request('primary', query, 2000);
            } catch (error) {
                console.warn('Primary geocoder unavailable; using fallback.', error);
                results = await this._request('fallback', query, 8000);
            }
            // Update with result and overwrite cache with the most recent 30 entries
            const cache = Object.fromEntries([
                ...Object.entries(this._readCache()), [key, { time: Date.now(), results }]
            ]);
            const recent = Object.entries(cache).sort((a, b) => b[1].time - a[1].time).slice(0, 30);
            localStorage.eventMapGeocodingCache = JSON.stringify(Object.fromEntries(recent));
            return results;
        };

        // Serialize requests to ensure rate limiting requirements
        const job = this._queue.then(search);
        // Keep the queue usable after a failure, but pass the real error to the caller
        this._queue = job.catch(() => {});
        return job;
    }

    // Nominatim requires result caching
    _readCache() {
        try {
            const cache = JSON.parse(localStorage.eventMapGeocodingCache || '{}');
            if (!cache || typeof cache != 'object' || Array.isArray(cache) ||
                Object.values(cache).some(entry => !entry || !Number.isFinite(entry.time) ||
                    !Array.isArray(entry.results) || entry.results.some(result =>
                        !result || typeof result.name != 'string' ||
                        !EventMapGeocoder.isValidCoordinate(result.lat, result.lng))))
                throw new Error('Invalid geocoding cache.');
            return cache;
        } catch (error) {
            console.warn('Discarding invalid geocoding cache.', error);
            localStorage.removeItem('eventMapGeocodingCache');
            return {};
        }
    }

    /** Process one geocoding request. */
    async _request(provider, query, timeout) {
        // Nominatim requires rate limiting to 1 request per second per site per IP address
        let wait;
        while ((wait = 1000 - (Date.now() - this._lastRequestTime)) > 0)
            await new Promise(resolve => setTimeout(resolve, wait));
        this._lastRequestTime = Date.now();

        // Construct the Nominatim request URL with query parameters
        const url = new URL(EventMapGeocoder.Providers[provider]);
        url.search = new URLSearchParams({
            q: query,
            format: 'jsonv2',
            limit: '5',
            addressdetails: '1',
            'accept-language': 'hu'
        });

        // Fetch the geocoding results with timeout to abort
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(url, {
                signal: controller.signal,
                referrerPolicy: 'strict-origin-when-cross-origin'
            });
            if (!response.ok)
                throw new Error(`Geocoder returned HTTP ${response.status}.`);
            const data = await response.json();
            if (!Array.isArray(data) || data.some(result =>
                !result || typeof result.display_name != 'string' ||
                !EventMapGeocoder.isValidCoordinate(result.lat, result.lon)))
                throw new Error('Invalid geocoder response.');
            return data.map(result => ({
                name: result.display_name,
                lat: Number(result.lat), lng: Number(result.lon),
                type: result.addresstype || result.type || ''
            }));
        } finally {
            clearTimeout(timer);
        }
    }

    /** Checks that a latitude/longitude pair is numeric and within range. */
    static isValidCoordinate(lat, lon) {
        return lat !== null && lon !== null && lat !== '' && lon !== '' &&
            Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) &&
            Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180;
    }
}
