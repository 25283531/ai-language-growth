# apps/admin-web — Parent & Admin Console

Next.js operator console for model provider settings. Open at port 3001 in the Docker Compose setup.

The management console requires the account configured by `ADMIN_USERNAME` and `ADMIN_PASSWORD` in Docker. After login, an HttpOnly session cookie authenticates management requests. Provider-specific fields are encrypted and saved by the backend; `MODEL_CONFIG_ENCRYPTION_KEY` protects credentials at rest. Supported adapters and their platform API notes are in `docs/architecture/model-provider-console.md`.

The page never reads saved secret values back from the API. Secret fields left blank keep the credentials already stored for that same provider. The operator can change the service URL to follow regional endpoints or provider URL changes.

Future parent progress, curriculum, and cost dashboards remain separate from this operator screen.

## 操作说明

### 打开页面即读取配置

`/providers`（模型接入）、`/settings`（系统设置）、`/learning`（学习与记忆）在管理员会话通过校验、页面挂载后自动读取已保存配置，并把加载中、读取失败、确实为空三种状态分开显示。读取失败时页面给出可见的「重试」入口；会话过期（`401` / `403`）时给出「重新登录」入口，重新登录后自动重试，不要停留在旧表单上继续保存。顶部的「重新读取配置」「重新读取设置」「刷新」按钮只作手动刷新，不是显示数据的唯一入口。供应商目录与模型配置分别读取，任一失败只影响自己那一条链路。

`/learning` 的「学习记忆」是按学习者 ID 的搜索型交互：输入学习者 ID 后点击「查询学习记忆」才会请求，页面不会自动加载该区；未查询前的空白不是加载失败。

### 新增、编辑、停用与删除模型配置

- 新增：点击「新增模型配置」生成一条草稿，填写预置平台、接入地址、模型名称与密钥，再点「保存并应用」创建；未保存草稿可用「取消新增草稿」放弃。
- 编辑：用「编辑：选择具体配置记录」下拉框选中并切换要编辑的记录；切换记录会清空密钥输入框，避免把一条配置的密钥误存到另一条。
- 保存：修改（包括「启用」开关）只改本地表单，需点击「保存并应用」才写入服务端。左侧服务徽标只读服务端返回的启用状态；表单内会显示「已配置 / 最后同步时间」以及是否还有未保存修改。
- 删除：点击「删除当前配置」后会打开二次确认面板，列出平台 · 模型、服务类型、当前是否启用、删除后该服务剩余启用配置条数，以及「任务路由」对该配置的首选 / 备用引用。面板提供「改为停用（推荐）」作为替代动作，也提供「取消」。删除凭据会一并清除。
- 删除 / 停用最后一个启用配置会被后端拒绝，因为保存与删除都会立即刷新运行时 provider，运行时可能回落 Mock 并影响正在上课的儿童下一回合。建议先新增并启用替代配置；确需继续时，确认面板中有显式勾选的强制继续项，请求会带 `force` 并附带在课会话影响说明。

### 密钥填写约定

- 同一平台编辑时密钥框留空表示保留已保存凭据；接口不回读密钥明文，页面只显示整体的「已有凭据」标记。
- 更换预置平台时旧平台凭据不再适用，页面会清除「已有凭据；留空保留已保存值」提示并改为「更换平台需重新填写密钥」，需要重新填写该平台的全部密钥字段。
- 已知缺口：凭据状态目前是整体布尔值，无法逐字段表达多密钥字段（例如 API Key / Secret Key / AppID）各自是否已保存；本轮按「换平台需重填全部密钥」处理。

### 部署前提

代码或 UI 改动需要重新构建 `admin-web` 镜像并部署后，才会在 Compose 的 `3001` 管理页面生效；修改源码本身不会改变正在运行的容器。
