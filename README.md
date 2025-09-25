# Captcha screenshots generator

## Start

1. `npm install`
2. `npx playwright install`
3. Edit `config.json` or copy the example `config.example.json`
4. Run generator `npm run gen`

### Config


`outDir` — куда складывать результат.

`viewport` — размер кадра.

`backgrounds` — список URL фонов (мы делаем из них скрин и кладём на фон как картинку).

`providers[]` — список провайдеров с числом кейсов, размером, вариантом, и флагом «кликать ли, чтобы открыть челлендж».

`positions` — диапазоны координат наложения виджета.

`randomize` — тема/язык/джиттер для разнообразия.

`split` — false (нет подпапок) или объект с долями {train,val,test}.

`yolo` — писать ли .txt с bbox (если нужен YOLO).

`includeChallengeBBox` — записывать ли bbox внутреннего окна челленджа в post.json.

`capture` — "pre"|"post"|"both" — сколько кадров на кейс.

`fullPage` — false быстрее (скрин = viewport).

`concurrency` — параллельных воркеров.

`disableIframeBackground` — не грузить bgUrl во фрейм (фон только как картинка).

`retries` — повторы задач при флаки-ошибках.

`timeouts` — таймауты загрузки страницы/iframe и задержка после клика.

`rendererUrl` — HOST URL