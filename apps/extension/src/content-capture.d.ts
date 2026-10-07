export function buildPayload(
  doc?: Pick<Document, "title"> & { documentElement: Pick<Element, "outerHTML"> },
  pageLocation?: Pick<Location, "href">,
): { url: string; title: string; html: string };
