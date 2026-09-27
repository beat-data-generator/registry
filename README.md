# Beat Data Generator Plugin Registry

[Beat Data Generator](https://github.com/BUGJI/beat_data_generator) 应用内插件市场的数据源。
客户端拉取本仓库根目录的 [`registry.json`](./registry.json)，据此展示插件并一键安装。

> English: this repository is the data source for the in-app plugin marketplace.
> The client fetches `registry.json`. To publish a plugin, add a curated
> `plugins/<name>.json` and cut a GitHub Release with a `plugin.zip` asset.

## 目录结构

```
plugins/<name>.json   # 每个插件一份人工维护的源文件（元数据 + versions）
registry.json         # 由 scripts/build-registry.mjs 生成，客户端读取的就是它
schema/               # JSON Schema（编辑器提示 / 文档用途）
scripts/              # 生成与同步脚本（无第三方依赖，Node >= 20）
```

- **元数据**（`id` / `repo` / `name` / `description` / `categories` / `tags` /
  `minAppVersion`）由人工在 PR 中维护。
- **`versions`** 由 [`sync-releases.yml`](./.github/workflows/sync-releases.yml)
  每日扫描各插件仓库的 GitHub Release 自动写入（取 `plugin.zip` 资产）。
- **`latest`** 由构建脚本从 `versions` 推导，永远与版本表一致。

## 收录新插件

1. 在 `plugins/` 下新增 `<name>.json`，字段见 [`schema/plugin.schema.json`](./schema/plugin.schema.json)：

   ```json
   {
     "id": "dev.bdg.my-plugin",
     "repo": "beat-data-generator/bdg_plugin_my",
     "author": "BUGJI",
     "categories": ["export"],
     "tags": ["demo"],
     "minAppVersion": "0.2.15",
     "name": { "zh": "我的插件", "en": "My Plugin" },
     "description": { "zh": "…", "en": "…" },
     "versions": {}
   }
   ```

   - `id` 必须与插件 `manifest.json` 的 `id` 完全一致（含大小写）。
   - `categories` 建议取值：`export` / `import` / `integration` / `visual` /
     `utility` / `analysis`。
   - `name` / `description` 支持字符串或 `{ "zh": "…", "en": "…" }`。

2. 本地生成并自检：

   ```bash
   node scripts/build-registry.mjs          # 重新生成 registry.json
   node scripts/build-registry.mjs --check  # 校验是否与源文件一致（CI 用）
   node scripts/sync-releases.mjs           # 需要 GH_TOKEN，拉取各仓库 Release
   ```

3. 提交 PR。合并到 `main` 后，`sync-releases` 会把已发布的版本补进索引。

## 发布插件版本（插件仓库侧）

在插件仓库打 tag（形如 `v1.2.3`，需与 `manifest.json` 的 `version` 一致），
组织级可复用工作流会：

1. 校验 `manifest.json`；
2. 打包 `plugin.zip`（`manifest.json` 位于压缩包根目录）；
3. 创建 GitHub Release 并上传 `plugin.zip`，同时打印 SHA-256。

调用方只需在插件仓库放一个 `.github/workflows/release.yml`：

```yaml
name: Release
on:
  push:
    tags: ["v*"]
jobs:
  release:
    uses: beat-data-generator/.github/.github/workflows/release-plugin.yml@main
    permissions:
      contents: write
```

随后本仓库的 `sync-releases` 会自动读取 Release 资产的 SHA-256（GitHub 的
`digest` 字段）并写入 `versions`。

## 安全约定

- 索引里每个版本的 `url` 必须为 HTTPS，`sha256` 必须是 64 位小写十六进制；
  客户端安装前强制校验。
- 插件目录以仓库为白名单：只有 `plugins/*.json` 中登记的 `repo` 会被扫描。
- `registry.json` 只由 CI / 脚本生成，不接受手改（`--check` 会拦截）。
