export function buildPayload(doc = document, pageLocation = location) {
  return {
    url: pageLocation.href,
    title: doc.title,
    html: doc.documentElement.outerHTML,
  };
}
