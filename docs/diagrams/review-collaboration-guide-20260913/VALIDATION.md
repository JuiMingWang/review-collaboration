# 圖稿驗證 — R13，2026-09-28

雙語導覽各含 12 張圖。最終 JSON 與 HTML 均通過 Archify 2.17 showcase 檢查（9/9、零錯誤與警告），且 HTML 的精確 bytes 與通過的瀏覽器收據相符。導覽索引另行檢查，不列入 Archify 圖稿判定。

瀏覽器檢查涵蓋 Windows Chrome 的 1440×900、1600×1000、1920×1080、2048×1320。主端查看最小及最大尺寸的明暗截圖，核對裁切、重疊、對比與路徑辨識。R11 重查全部 12 張英文圖及中文 04b、07、08，共 60 張最終截圖；其餘九張未變的中文圖以來源、HTML 與截圖雜湊比對，沿用 R10 的 36 張影像檢視證據。公開 PNG 精確複製最終 2048×1320 明色截圖。

早期英文緊湊布局未通過可讀性或路徑檢查，有限修正後已停用，改以較寬節點及調整邏輯欄位的布局通過。接入路徑與復原標題亦以最終成品重新核對。失敗候選只留在本機證據，不當成通過成品發布。

機器收據仍保留 `visualReview: pending`，主端影像檢視另存綁定雜湊的紀錄。上述檢查無法證明審查品質、token 節省、零資訊流失、新手理解程度、手機或所有瀏覽器支援。本次發布沒有新增外部 reviewer 或原生主端實跑的驗證主張。英文版翻譯作者文字；固定檢視器 UI 可能保留英文回退。

R12 重繪 03、04a、04b 的中英文版（共 6 張），改為逐點討論到有結論、送回駁回理由及續談上限；每種語言其餘 9 張圖的來源、HTML 與 PNG 未變，沿用上述 R11 證據。重繪使用本機較新的 Archify 2.17.0-dev.1 建置：以未修改的 04a 來源重畫，圖形 SVG 與舊建置逐 byte 相同；差別在 Viewer 內嵌字型、不再從網路載入，因此這 6 個 HTML 較大。6 張圖均通過 showcase 檢查（9/9、零錯誤與警告）及 visual-check（四種尺寸皆無溢出），HTML bytes 與通過的收據相符。主端檢視明暗截圖，並為避免線段共用或繞行，替 04a 加上端點側與通道設定。公開 PNG 仍精確複製 2048×1320 明色截圖。

R13 以同一個 Archify 2.17.0-dev.1 建置重新產生其餘 18 張圖（每種語言的 01、02a、02b、05a、05b、06、07、08、09），圖稿 JSON 未改。重新產生的圖形 SVG 與舊版逐 byte 相同；差別只在 Viewer 內嵌字型、不再從網路載入，因此 HTML 較大。18 張均通過 showcase 檢查（9/9、零錯誤與警告）及 visual-check（四種尺寸皆無溢出），HTML bytes 與通過的收據相符。主端抽查三張明暗截圖；公開 PNG 精確複製 2048×1320 明色截圖。現在 24 張圖都使用同一版 Viewer。

## 精確成品

| 檔案 | Bytes | SHA-256 |
| --- | --- | --- |
| 01-overview.workflow.json | 3084 | 1a664bfe7988bf5332be43fe086068ad0a77c4634fde21e6e12fa3b699d9395d |
| 01-overview.html | 805142 | c8b56792354f1b6a8feb00d883a1b725b80ef6e4a7b3d9c31a7fc736cc33eb3d |
| 01-overview.png | 144236 | 24a07fe3db1a20e9bbdbf27e387a694dc3bc960b94e715b3697fde6634750d5d |
| 02a-selection.workflow.json | 4060 | 6b329cf788acb32dde502077d7072cb1558bea831324813b828bd6928acf6e8a |
| 02a-selection.html | 810284 | 53011093bcfe9406f88c730b55f5c0513768f98fa7d04d9a04bc93fb551fc0ab |
| 02a-selection.png | 179152 | 69c614d4fac2265e572e0b8621a0f1317a61f32b45aa21274a490bf82afb63a8 |
| 02b-connection.workflow.json | 4074 | 7d9093b6165ee3fa5a76b15230e715264e807da85bba3d177c682aaa7e0e866c |
| 02b-connection.html | 809790 | 9bdfc855bef72809851389c1b2d237caab2df281a3be7a118d56d5a68af6672e |
| 02b-connection.png | 178336 | 4ff82c950ab002ee6c36b4e5dbd86d0e4c7f7874b4fd27fd517e44f8816171ef |
| 03-handoff.workflow.json | 4280 | 1ba7274a83badac3c61484f9b7ccb683ee4f4b75f4b97fd4d8b9aa7316602155 |
| 03-handoff.html | 810378 | b0fa3af6718dba94f53e86a94b96f5626b13100807ed4e59597049f19ff7395a |
| 03-handoff.png | 186910 | 9ce427205a909e9f512ac2fb0a268606ac2b721dde849e083cd99e1b0cbb7c56 |
| 04a-discussion.workflow.json | 4496 | ad1d087c1428a25aca30b2378fc900ad0a7e2183b737fd292621a2164a3e39ac |
| 04a-discussion.html | 811807 | b6634c35c7787a96afa32eb97aa835741a3fadafbf60236ffc4fd7c3ee12ba80 |
| 04a-discussion.png | 177418 | 04a812922b8ffbf4cde581ab9167d95ac16064fc7f985edb09bfc47d436d2d5e |
| 04b-adoption.workflow.json | 4315 | f59db1205e531a895dbb0ff32725e1841f118ceec840a34ebbe86cf3c8e4f6b3 |
| 04b-adoption.html | 810848 | 32307671b4bfee1917af0ef1b1f72247509ad9629578585a2c934121740c4c35 |
| 04b-adoption.png | 180870 | 4914b6bd64d09b8bb7366a4ede15e0a639cbc343e81977b03df714b5ee68290b |
| 05a-send.sequence.json | 2511 | 31ca057759108e33f87efa045c3b5b9741c1cea556fdc2a37454d77826805d83 |
| 05a-send.html | 803125 | 823c0948ebce53b7b8606bbba971137808883785367d478a8fbcd1b1ec2e6819 |
| 05a-send.png | 129552 | bc8fd761e134bae07ded6b9b8cd981c5ce1d7470616e9a80ee966f2684753fc1 |
| 05b-finalize.sequence.json | 2482 | 2398d0009990151e055e0da6a1d42b20beee4e743e5326e4e988093e677ffacc |
| 05b-finalize.html | 802770 | 0311574454d650df320cd34aac941996e4d25f6179dffde526328c8c96a10db0 |
| 05b-finalize.png | 130061 | 6bf5fbcef4a1ffbb9159d75093f12a7f2b1f69e5c5ff46f42064bd677bb25aed |
| 06-recovery.workflow.json | 4337 | abef78956a8a39ea990089a13157f9159879c480fb0a19793fdd600e06ca5c64 |
| 06-recovery.html | 811719 | d38c3952d6365801dae4250e03df8364670dd46ed0f3d3d5fd6e19f9d8f07df3 |
| 06-recovery.png | 186330 | 877af6acc53ce340ca10df70a8340d9fe265ca7a03b9aa3e51daadfbd571329b |
| 07-improvement.workflow.json | 4569 | 849536051362e09b78d921ba95ddbcd697fddb6e76674a445c6ce0d5fdb2dd36 |
| 07-improvement.html | 811895 | 40b1cb588caffb07f2998a237304dafbc03c4f244085cec943f9f11d62bb6b21 |
| 07-improvement.png | 181485 | c091c4cd1dc45fd183a0ea18ed76d7158c9e63a1686fc6d67ea83506a5e959fa |
| 08-programs.architecture.json | 4648 | d5facb6ab69a0a38145a5cef591fa5043107581435d39c7dbbe17d7b7e16b903 |
| 08-programs.html | 812119 | 08da84653ed3663a46f954d18edf06751fe476e272b4c698443d34561cca712f |
| 08-programs.png | 178298 | 23ae34c4cdb32ec603f3a2bbe765612e034a6b9a9f1f7365ab478f13eebb7b92 |
| 09-support-and-data.architecture.json | 4626 | bf754d5b3c3a57356ffe146601e419b635f1bb882b182947dbdaf80ed706e961 |
| 09-support-and-data.html | 812064 | 2011e8a9fa487763fc7ed8248a16f38d9104d3f787426c01ae3c42759a1e8494 |
| 09-support-and-data.png | 189820 | 6f57b8cd42f98e41fb111fe060c20fb204d9d3e1a431bc623d3650c1ffb30c9b |

上層 `release-manifest.json` 列出所有公開導覽檔案，不含原始瀏覽器收據及私人機器路徑。
