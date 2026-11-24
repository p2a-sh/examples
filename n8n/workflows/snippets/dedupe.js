const LIMIT = 500;

function remember(store, eventId) {
  if (!store || typeof store !== 'object') {
    throw new Error('dedupe store must be an object');
  }
  if (!Array.isArray(store.ids)) store.ids = [];
  const id = String(eventId || '');
  if (!id) return { duplicate: false };
  if (store.ids.indexOf(id) !== -1) return { duplicate: true };
  store.ids.push(id);
  if (store.ids.length > LIMIT) store.ids.splice(0, store.ids.length - LIMIT);
  return { duplicate: false };
}

if (typeof $input !== 'undefined') {
  const staticData = $getWorkflowStaticData('global');
  return $input.all().map((item, index) => {
    const body = item.json && item.json.body;
    const eventId = body && body.event_id;
    const result = remember(staticData, eventId);
    return {
      json: Object.assign({}, item.json, { duplicate: result.duplicate }),
      pairedItem: { item: index },
    };
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { remember, LIMIT };
}
