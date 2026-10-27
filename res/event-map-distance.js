/** Calculates coord distances from location off the map's rendering thread. */
self.onmessage = ({ data: { id, location, coordinates } }) => {
    const radians = Math.PI / 180;
    const latitude = location[0] * radians;
    const distances = new Float64Array(coordinates.length);
    for (const [index, point] of coordinates.entries()) {
        // Haversine formula for calculating distances on an orb surface
        // See: https://codebounce.net/haversine-formula/
        const latitudeDelta = (point[0] - location[0]) * radians;
        const longitudeDelta = (point[1] - location[1]) * radians;
        const haversine =
            Math.sin(latitudeDelta / 2) ** 2 +
            Math.cos(latitude) * Math.cos(point[0] * radians) *
            Math.sin(longitudeDelta / 2) ** 2;
        distances[index] = 6371000 * 2 * Math.atan2(
            Math.sqrt(Math.min(1, haversine)), Math.sqrt(Math.max(0, 1 - haversine)));
    }
    self.postMessage({ id, location, distances }, [distances.buffer]);
};