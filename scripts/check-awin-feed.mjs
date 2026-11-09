import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

// Comprueba el acceso al feed Enhanced de Awin sin publicar fichas ni imprimir el token.
export async function checkAwinFeed({ publisherId, advertiserId, locale = 'es_ES', token }, request = fetch) {
  if (!/^\d+$/.test(publisherId ?? '') || !/^\d+$/.test(advertiserId ?? '') ||
      !/^[a-z]{2}_[A-Z]{2}$/.test(locale) || !token?.trim()) {
    throw new Error('Configura AWIN_PUBLISHER_ID, AWIN_ADVERTISER_ID, AWIN_API_TOKEN y, si corresponde, AWIN_LOCALE.');
  }

  const url = new URL(`/publishers/${publisherId}/awinfeeds/download/${advertiserId}-retail-${locale}.jsonl`, 'https://api.awin.com');
  const response = await request(url, {
    headers: { Authorization: `Bearer ${token.trim()}` },
    redirect: 'error',
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Awin no entregó el feed Enhanced (HTTP ${response.status}). Comprueba acceso y formato del feed.`);
  }

  const input = Readable.fromWeb(response.body);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let products = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        throw new Error('Awin devolvió una línea JSONL inválida.');
      }
      if (!item || typeof item !== 'object' || Object.hasOwn(item, 'error')) {
        throw new Error('Awin devolvió un feed incompleto o inválido.');
      }
      if (!item.product_basic?.id || !item.product_basic?.title) {
        throw new Error('Una ficha carece del identificador o título del formato Enhanced.');
      }
      products++;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!products) throw new Error('El feed Enhanced está vacío.');
  return { advertiserId, locale, products };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkAwinFeed({
      publisherId: process.env.AWIN_PUBLISHER_ID,
      advertiserId: process.env.AWIN_ADVERTISER_ID,
      locale: process.env.AWIN_LOCALE || 'es_ES',
      token: process.env.AWIN_API_TOKEN
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
