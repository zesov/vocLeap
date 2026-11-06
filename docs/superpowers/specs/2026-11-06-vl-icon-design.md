# VL Icon 設計 — 2026-11-06

## 目標

以 **VL** 兩個字母為基礎,取代現有 VocLeap app icon。
現有 icon 的問題:只有 "V" 沒有 "L"、依賴系統字型渲染(`<text>`,各裝置粗細不一)、附帶陰影與軌跡點裝飾。

## 最終設計(經視覺共創選定)

- **底色**:對角線性漸層,左上 `#4f46e5` → 右下 `#3b82f6`
- **容器**:圓角方形,圓角半徑 = 邊長 22%(512 viewBox 即 `rx=113`)
- **標誌**:白色 `#ffffff` 單一 path,**一筆連體 VL** — V 的右筆上收至頂端後折下成 L 的豎筆與橫腳
  - 幾何(100×100 座標空間,設計母版):
    `M22.5 31.7 L42.7 73.8 L62.8 31.7 L62.8 55.5 L79.3 55.5`
  - **座標慣例**:所有 SVG 檔一律用 `viewBox="0 0 100 100"`(直接引用母版幾何),尺寸只由 `width`/`height` 屬性表達 — `icon-512.svg` 為 `width="512" height="512"`,`icon-192.svg` 為 `width="192" height="192"`,兩者內容除尺寸屬性外完全一致
  - `stroke-width="10"`,`stroke-linecap="round"`,`stroke-linejoin="round"`,`fill="none"`
- **幾何限制**:標誌所有點(含 stroke 半徑)與畫布中心的距離 ≤ 40%,符合 PWA maskable 安全圓
- **風格**:flat,無陰影濾鏡、無裝飾元素、不使用 `<text>` / 系統字型
- 決策過程:4 個方向(並排/連體/跳躍/極簡)→ 選「一筆連體」→ 3 種處理(同色/雙色/分離)→ 選「同色」→ 4 種底色 → 選「靛藍漸層」

## 更新範圍

| # | 檔案 | 動作 |
|---|------|------|
| 1 | `public/icons/icon-512.svg`、`public/icons/icon-192.svg` | 重寫為新設計;檔名與尺寸宣告不變 |
| 2 | `app/favicon.ico` | 由最終 SVG 產 16/32/48 PNG,重新打包成多尺寸 ICO |
| 3 | `src-tauri/icons/*` | 以最終 SVG 輸出 1024px PNG,執行 `bunx tauri icon` 重產全部(`.ico`、`.icns`、`Square*`、`StoreLogo`) |
| 4 | `public/manifest.json` | `theme_color` 由 `#3b82f6` 改為 `#4f46e5`,配合新 icon |

## 產出工具

- **SVG → PNG**:專案既有 `sharp`(node_modules)
- **ICO 打包**:sharp 產出各尺寸 PNG 後,以小腳本手寫 ICO 容器(Vista+ 支援內嵌 PNG);失敗則退回 `bunx png-to-ico`
- **Tauri 圖示**:`node_modules/.bin/tauri` 已存在,`bunx tauri icon <1024.png>` 一次重產全套

## 驗收方式

1. `bun run dev` 起動,`/favicon.ico`、`/icons/icon-192.svg`、`/icons/icon-512.svg` 回應 200 且內容為新設計
2. Playwright 對 `/icons/icon-512.svg` 截圖,與設計預覽比對(漸層方向、圓角、標誌位置)
3. `src-tauri/icons/` 與重產前檔案清單一致,全部 mtime 更新
4. 16/24/32px 小尺寸目視可讀性確認
5. 純資產變更,`bunx tsc --noEmit` 不受影響(例行確認)

## 不做的事(Out of scope)

- 不改 NavBar 文字 logo 與 app 內 UI 顏色(theme_color 僅影響 PWA 標題列/啟動畫面)
- 不改 manifest 的 icon 檔名與尺寸清單
- 不新增 icon 使用位置(如 og:image)
