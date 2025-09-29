# Captcha screenshots generator

## Start

1. `npm install`
2. `npx playwright install`
3. Edit `config.json` or copy the example `config.example.json`
4. Run generator `npm run gen`

### Config

`outDir` `(string)`

Папка, куда сохраняются выходные файлы. Будет создана автоматически, если не существует.

По умолчанию: "out".

---

`viewport` `(object)`

Размеры “экрана” браузера.

- `width` `(number)` — ширина в пикселях.
- `height` `(number)` — высота в пикселях.

По умолчанию: { "width": 1280, "height": 800 }.
Совет: чем меньше viewport, тем быстрее скриншоты; но не уменьшайте слишком сильно, чтобы виджеты не “ломались”.

---

`backgrounds` `(string[])`

Список URL-страниц, которые будут использованы как фон (снимок страницы конвертируется в картинку и подставляется под капчу).

- Значения: абсолютные http(s)-URL.
- Чем меньше уникальных URL — тем быстрее (кешируется).

Важно: многие сайты запрещают встраивание в `<iframe>` (X-Frame-Options).

---

`providers` `(ProviderCfg[])`

Список источников капч и сколько примеров сделать для каждого. Элемент массива:

- `name` `("recaptcha" | "hcaptcha" | "turnstile")` — провайдер.
- `count` `(positive integer)` — сколько кейсов генерировать (если capture = "both", на кейс будет 2 файла: _pre и _post).
- `size` `(string)` — размер виджета (значения зависят от провайдера):
   - `reCAPTCHA v2`: "normal" | "compact".
   - `hCaptcha`: `"normal" | "compact"`.
   - `Turnstile`: `"auto" | "normal" | "compact".
- `variant` `(string, optional)` — подвид/режим:
   - `reCAPTCHA`: `"checkbox"` (видимый чекбокс; не v3).
   - `hCaptcha`: `"checkbox"`.
   - `Turnstile`: `"interactive"` или ваше значение для data-action (не влияет на скриншот кардинально).

- `openChallenge` `(boolean, optional)` — пытаться кликнуть по виджету, чтобы открыть окно с картинками/челлендж (полезно для hCaptcha/reCAPTCHA).
  **Рекомендации**:
  - reCAPTCHA/hCaptcha: true — чаще увидите сетку/картинки.
  - Turnstile: часто false — у него не всегда есть “отдельное окно”.

!!! - Ключи провайдеров: встраиваются в ваш index.html рендера (не в config.json). Для reCAPTCHA UI используйте v2 Checkbox ключи (v3 — невидимая, без картинок).

--- 

`positions` `(object)`

Границы случайного размещения оверлея капчи.
 - `x`: `{ min: number, max: number }`
 - `y`: `{ min: number, max: number }`

Единицы: пиксели относительно левого верхнего угла viewport.
Совет: держите max с запасом от края, чтобы виджет не “уползал” за пределы.

---

`randomize` `(object)`

Случайные параметры кадра.

- `theme`: `["light","dark"]` — палитра виджета (если провайдер поддерживает).

- `languages`: `string[]` — коды локали (например, "en", "ru", "es"). Пробрасываются через hl в скрипты провайдеров.

- `jitter`: `number` — небольшой случайный сдвиг (± пикселей) к выбранным x/y, чтобы увеличить разнообразие.

---

`split` `(false | object)`

Разложение выходных данных по подпапкам датасета.

`false` — отключено, файлы пишутся в `out/<prov>/`.

`{ "train": number, "val": number, "test": number }` — вероятности раскладки в сумме = 1.

Пример: { "train": 0.8, "val": 0.1, "test": 0.1 } создаст подпапки train/, val/, test/.


---

`yolo` `(boolean)`

Писать ли рядом с PNG ещё и YOLO-разметку (.txt) для обёртки капчи (.cap-wrapper).

- `true` — писать.
- `false` — не писать (если используете только JSON).
Примечание: класс берётся из CLASS_ID в коде (recaptcha:0, hcaptcha:1, turnstile:2 — можете поменять порядок по своим нуждам).

---

`includeChallengeBBox` `(boolean)`

Добавлять ли в POST-метаданные (*_post.json) координаты внутреннего iframe окна челленджа (если оно появилось).

- Для reCAPTCHA — `api2/bframe`.
- Для hCaptcha — iframe с `title*="challenge"`.
Значения: `true`/`false`.

---

`capture` `("pre" | "post" | "both")`

Какие кадры сохранять:

- `"pre"` — до клика по виджету.
- `"post"` — после клика (попытка открыть окно).
- `"both"` — два файла на кейс: _pre.png и _post.png.
Влияние на количество файлов: count * (1 или 2) на провайдера.

---

`fullPage` `(boolean)`

Какой скрин делать:

- `false` — только viewport (быстрее, экономит память).

- `true` — полноразмерный скроллируемый скрин всей страницы (медленнее, крупные PNG).

---

`concurrency` `(number)`

Сколько параллельных “воркеров” (открытых вкладок) запускать.

Обычно 4–12.
> **Замечание**: слишком большое значение может упереться в лимиты CPU/памяти/сети и замедлить процесс.

---

`disableIframeBackground` `(boolean)`

Нужно ли отключить подгрузку bgUrl в iframe на странице-рендерере.

- `true` — не грузим iframe, используем только кешированную картинку фона (макс. стабильность и скорость).

- `false` — ещё и пытаемся подгрузить страницу в iframe (не всегда возможно из-за X-Frame-Options; обычно не нужно).

---

`retries` `(number)`

Сколько раз повторить задачу при флейках (временные ошибки сети/рендера).
**По умолчанию: 1.**

---

`requireWidget` `(boolean)`

делать PRE-скрин только если виджет реально найден (iframe виджета существует и имеет bbox).
**По умолчанию: true.**

---

`requireChallengeForPost` `(boolean)`

для POST: сохранять только если после клика реально появился iframe челленджа.

**По умолчанию: true.**

---

`timeouts` `(object)`

Тонкая настройка таймингов:

- `pageLoadMs` — ожидание загрузки страницы-рендерера (index.html). Можно уменьшать для ускорения, если хост стабилен.

- `providerIframeMs` — ожидание появления iframe провайдера (виджета).

- `afterClickDelayMs` — пауза после клика по виджету (даём времени перепрыгнуть в состояние “challenge”).

---

`rendererUrl` `(string)`

URL вашего index.html рендера (обычно GitHub Pages).

Пример: https://keofoxy.github.io/captcha-generator/index.html.

Внутри этой страницы должны быть ваши sitekey провайдеров (под ваш домен).
> **Внимание**: для UI-кадров Google нужна reCAPTCHA v2 (Checkbox), v3 — невидимая (без картинок).

---
