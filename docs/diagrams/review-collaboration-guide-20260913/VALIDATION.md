# 圖稿驗證 — R11，2026-09-13

雙語導覽各含 12 張圖。最終 JSON 與 HTML 均通過 Archify 2.17 showcase 檢查（9/9、零錯誤與警告），且 HTML 的精確 bytes 與通過的瀏覽器收據相符。導覽索引另行檢查，不列入 Archify 圖稿判定。

瀏覽器檢查涵蓋 Windows Chrome 的 1440×900、1600×1000、1920×1080、2048×1320。主端查看最小及最大尺寸的明暗截圖，核對裁切、重疊、對比與路徑辨識。R11 重查全部 12 張英文圖及中文 04b、07、08，共 60 張最終截圖；其餘九張未變的中文圖以來源、HTML 與截圖雜湊比對，沿用 R10 的 36 張影像檢視證據。公開 PNG 精確複製最終 2048×1320 明色截圖。

早期英文緊湊布局未通過可讀性或路徑檢查，有限修正後已停用，改以較寬節點及調整邏輯欄位的布局通過。接入路徑與復原標題亦以最終成品重新核對。失敗候選只留在本機證據，不當成通過成品發布。

機器收據仍保留 `visualReview: pending`，主端影像檢視另存綁定雜湊的紀錄。上述檢查無法證明審查品質、token 節省、零資訊流失、新手理解程度、手機或所有瀏覽器支援。本次發布沒有新增外部 reviewer 或原生主端實跑的驗證主張。英文版翻譯作者文字；固定檢視器 UI 可能保留英文回退。

## 精確成品

| 檔案 | Bytes | SHA-256 |
| --- | --- | --- |
| 01-overview.workflow.json | 3084 | 1a664bfe7988bf5332be43fe086068ad0a77c4634fde21e6e12fa3b699d9395d |
| 01-overview.html | 708549 | 775af0d8d233eb2eef0ae969a8725ecc1f7c99ed68dd46434de60ebb948a5f73 |
| 01-overview.png | 144023 | 63f034383d948a509c7389c713e9f4cca5cba6be17f24b0e821ab19addad1495 |
| 02a-selection.workflow.json | 4060 | 6b329cf788acb32dde502077d7072cb1558bea831324813b828bd6928acf6e8a |
| 02a-selection.html | 713691 | 0ed5f0cb1f91b6a20fcde3110d7bc6425cae3f6653130d8b7f96872af4be9cff |
| 02a-selection.png | 179245 | a067df3a633624abe7878ce221f6a019c52bad6b61566559f6065b5313db3b6b |
| 02b-connection.workflow.json | 4074 | 7d9093b6165ee3fa5a76b15230e715264e807da85bba3d177c682aaa7e0e866c |
| 02b-connection.html | 713197 | 2eebf5e6002117f740b621fccc0e804dfe2f0e3944e4185fd79347e051dc3f99 |
| 02b-connection.png | 178258 | b2862e59652068afd831cf107717395f2406fb92d936ba00230c75908508d3d5 |
| 03-handoff.workflow.json | 4268 | dd0169f417ab77763b1ad50b822e142b1b65168e4784b2d4e574d8b2554d2ae1 |
| 03-handoff.html | 713737 | 79a575f326e1f996dea91c09d88d5ba153171d6620bd1c340d6eff6e7d74f3ab |
| 03-handoff.png | 185796 | 4426505aa64fe668d0cfbcbb874083a847a4f75c5d56b2afc687febbd0c80142 |
| 04a-discussion.workflow.json | 4192 | c80d2b8f546264891457b5542aebec0fbd61174f4572f0bb7000d19b95734bc8 |
| 04a-discussion.html | 714486 | 7b36187954870ba280af24cefdf7e40b2274bc249420db8778d74b93fac74483 |
| 04a-discussion.png | 174690 | 515d32f2bf6802d12af48b1461e4bd51abe511375d6024a2faa0f4dc34d347fe |
| 04b-adoption.workflow.json | 4207 | c784a0fb7473abba9594ce700e7479b6b08017d2231b201b392d377f7f3ef008 |
| 04b-adoption.html | 714096 | d4ac4e02a4a18f56dc8949828c7abf4f58826f5cb9292e943d3b68679200e9e7 |
| 04b-adoption.png | 180804 | 0feccc38e93a438c48ab74541501320d3f7aabf37a788492b09b8650e46b580a |
| 05a-send.sequence.json | 2511 | 31ca057759108e33f87efa045c3b5b9741c1cea556fdc2a37454d77826805d83 |
| 05a-send.html | 706532 | 23f9ab272a7f96a97f8272cb386bfe4a6c758d947de75eac10592cf71e5012eb |
| 05a-send.png | 129563 | 46d37b210a5312d12b34101d97fc3219a95bf8fc6558d1eb5d91317ebcc35df4 |
| 05b-finalize.sequence.json | 2482 | 2398d0009990151e055e0da6a1d42b20beee4e743e5326e4e988093e677ffacc |
| 05b-finalize.html | 706177 | 246e2f7178eb19013f031c96cdf3dfd190987a587601e6f0a3eb9c1339c7524c |
| 05b-finalize.png | 130126 | d61ff2deb0ffb23ce9bef35b54157aa5be0991c76d1c01fb4f1024c516c4a296 |
| 06-recovery.workflow.json | 4337 | abef78956a8a39ea990089a13157f9159879c480fb0a19793fdd600e06ca5c64 |
| 06-recovery.html | 715126 | 072f32d4f2cf91b187ac52277176e2e75c81aed6de17fea7fa391cb02bf9e4cf |
| 06-recovery.png | 186136 | 96a7cf79a292597caea5c7a73fe12f3c2a209205340589ca718ab6c09f350233 |
| 07-improvement.workflow.json | 4569 | 849536051362e09b78d921ba95ddbcd697fddb6e76674a445c6ce0d5fdb2dd36 |
| 07-improvement.html | 715302 | 74a32d456bae5464661b5f959eef2eaa7ddf7c323bb5a4bf2dd4f5dff06760e8 |
| 07-improvement.png | 181588 | 97c2cd828e28ca2819377718ef40e7667f885e93e121e5a75e81a28d0818a2f3 |
| 08-programs.architecture.json | 4648 | d5facb6ab69a0a38145a5cef591fa5043107581435d39c7dbbe17d7b7e16b903 |
| 08-programs.html | 715526 | e8311e5615ce5f3f91e90031f15b0ab40ce8f552343df8136060d8e4a94a8a6a |
| 08-programs.png | 178366 | 47ee473b3048c347627693b90cad7d23c827b16c1d61f789351120e89dba1258 |
| 09-support-and-data.architecture.json | 4626 | bf754d5b3c3a57356ffe146601e419b635f1bb882b182947dbdaf80ed706e961 |
| 09-support-and-data.html | 715471 | 5a65b5e113574d3916ce7a110d1b8a3e3539db9eccdacadfa66bd44b62106a6e |
| 09-support-and-data.png | 189961 | 486bcb42f7d0d60ac6ac5c84c4064123056df273d64ba422041ff4a9be9b6a7e |

上層 `release-manifest.json` 列出所有公開導覽檔案，不含原始瀏覽器收據及私人機器路徑。
