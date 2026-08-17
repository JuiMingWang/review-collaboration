# 清單擬定的參考來源：不用 agency-agents 自帶檢索，改延後自建地圖

**Status**: superseded by [ADR-0007](./0007-reviewcollab-checklist-reference-source-pluggable.md)

產出者擬「審查清單」時，除了憑自己現場判斷，也可以參考 agency-agents 角色檔案裡整理好的領域檢查項目，降低清單被產出者自身盲區侷限的風險（見 [ADR-0003](./0003-checklist-floor-not-ceiling.md)）。但要怎麼從 agency-agents 裡找到對應內容，有兩條路可選，這裡決定走哪一條。

## 為什麼不用 agency-agents 自帶的 Hermes plugin 檢索

agency-agents 本身附帶一個關鍵字比對的檢索腳本（`scripts/build-hermes-plugin.py` 裡的 `_score()`），但這是為了組建一整套「Hermes plugin」路由系統設計的——這套系統的用途是幫任務自動挑選該轉給哪個角色，用途正是我們已經排除掉的「角色選角」，不是我們要的「找檢查清單內容」。這個腳本能不能脫離整套 Hermes plugin、單獨當一個簡單的「給關鍵字、回傳相關檔案」工具用，沒有驗證過，貿然依賴會欠一筆不確定的技術債。

## 決定：延後自建地圖，用純 markdown、不依賴任何腳本

改用自建的索引/地圖（純 markdown 檔案，可搭配 Obsidian 式的 wiki-link），由產出者一次性瀏覽 agency-agents 角色檔案，整理出跨角色重複出現的通用檢查類別，寫成地圖存在本專案 `docs/reference/` 底下。之後產出者擬清單時，只需要讀這份地圖（成本低），不需要跑任何腳本、不需要理解 Hermes plugin。

建置時機延後到實際撰寫 SKILL.md、確定清單機制具體格式之後再做，避免現在先建、之後格式不合用又要重做。在地圖建好之前，產出者每次擬清單一律照原設計自行現場擬定，不受影響——地圖只是**額外**的參考來源，不是清單機制運作的必要條件。

## Considered Options

- **使用 agency-agents 自帶的 Hermes plugin 檢索腳本**：不採用，用途錯位（角色選角非清單檢索），且能否單獨使用未驗證。
- **現在就建立自建地圖**：不採用，清單機制的具體格式尚未在 SKILL.md 中定案，現在建有白工風險。
- **延後自建、純 markdown 索引，建好前清單機制不受影響（採用）**：不依賴任何未驗證腳本，建置時機對齊實際需求，且不是必要條件、不影響清單機制現在就能運作。
