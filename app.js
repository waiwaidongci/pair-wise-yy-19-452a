/* =========================================================================
 * 岩芯薄片索引台 —— 钻孔分层归位与交接核销
 *
 * 业务由三个互相独立的部分承担：
 *   Intake      录入：只负责把表单整理成登记草稿，不做判定、不碰存储；
 *   Positioning 归位判定：只负责缺图/层位/岩层缺陷、同孔区间重叠、
 *               相邻层提示与导出次序的计算，不做保存；
 *   Repository  保存：只负责记录的落库、改写、删除与持久化，不做规则判定。
 * 控制器（下方 wiring）负责把三者串起来。
 * ========================================================================= */

const storageKey = "wxyy-2-thin-section-index";

const ISSUE = {
  NO_PHOTO: "缺显微照片",
  BAD_INTERVAL: "层顶深度不低于层底（或深度缺失）",
  ROCK_UNKNOWN: "岩层未判"
};

/* ------------------------------------------------------------------ *
 * 业务部分三：Repository（保存）
 * 只管读写，不理解任何归位规则。
 * ------------------------------------------------------------------ */
const Repository = (() => {
  // 惰性加载：normalize 依赖 Positioning，首次访问时三个业务部分都已定义
  let state = null;
  const store = () => {
    if (!state) {
      const raw = JSON.parse(localStorage.getItem(storageKey) || "{}");
      state = {
        samples: (raw.samples || []).map(normalize),
        compare: raw.compare || []
      };
    }
    return state;
  };

  const persist = () => localStorage.setItem(storageKey, JSON.stringify(store()));

  return {
    get state() {
      return store();
    },
    persist,
    // 新登记整条入库（是否有效由 Positioning 判定，保存不挑记录）
    add(record) {
      store().samples.unshift(record);
      persist();
    },
    // 整条替换；旧记录本身原样保留到替换发生为止
    replace(id, next) {
      const s = store();
      s.samples = s.samples.map((item) => (item.id === id ? next : item));
      persist();
    },
    remove(id) {
      const s = store();
      s.samples = s.samples.filter((item) => item.id !== id);
      s.compare = s.compare.filter((item) => item !== id);
      persist();
    },
    setCompare(ids) {
      store().compare = ids;
      persist();
    }
  };
})();

/* ------------------------------------------------------------------ *
 * 业务部分一：Intake（录入）
 * 只从表单 / 复核表单提取字段，产出登记草稿。
 * ------------------------------------------------------------------ */
const Intake = {
  fromForm(form, photo) {
    const data = new FormData(form);
    return {
      photo,
      code: data.get("code").trim(),
      borehole: data.get("borehole").trim(),
      collector: data.get("collector").trim(),
      layerTopText: data.get("layerTop").trim(),
      layerBottomText: data.get("layerBottom").trim(),
      rockLayer: data.get("rockLayer").trim(),
      location: data.get("location").trim(),
      magnification: data.get("magnification").trim(),
      polarization: data.get("polarization"),
      minerals: data.get("minerals").trim(),
      texture: data.get("texture").trim(),
      comment: data.get("comment").trim()
    };
  },
  // 复核 / 层位更正面板（DOM 读取，不触碰存储；复核人来自面板顶部公共输入）
  fromReview(el) {
    const val = (sel) => el.querySelector(sel)?.value.trim() ?? "";
    return {
      code: val("[data-r-code]"),
      borehole: val("[data-r-borehole]"),
      collector: val("[data-r-collector]"),
      layerTopText: val("[data-r-top]"),
      layerBottomText: val("[data-r-bottom]"),
      rockLayer: val("[data-r-rock]"),
      reviewer: val("[data-r-reviewer]"),
      note: val("[data-r-note]")
    };
  }
};

/* ------------------------------------------------------------------ *
 * 业务部分二：Positioning（归位判定）
 * 纯计算：缺陷、同孔区间重叠、相邻层、导出次序。同一份判定供
 * 录入退回、复核核销、筛选/相邻层提示/导出/刷新共用，结果一致。
 * ------------------------------------------------------------------ */
const Positioning = {
  parseDepth(text) {
    if (text === "" || text == null) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  },

  // 自身缺陷：缺图、层顶不低于层底、岩层未判
  ownIssues(draft) {
    const issues = [];
    const top = this.parseDepth(draft.layerTopText);
    const bottom = this.parseDepth(draft.layerBottomText);
    if (!draft.photo) issues.push(ISSUE.NO_PHOTO);
    if (top === null || bottom === null || top >= bottom) issues.push(ISSUE.BAD_INTERVAL);
    const rock = (draft.rockLayer || "").trim();
    if (!rock || rock === "未判") issues.push(ISSUE.ROCK_UNKNOWN);
    return issues;
  },

  intervalsOverlap(aTop, aBottom, bTop, bBottom) {
    // 端点相接（一层层底 = 下一层层顶）不算重叠
    return aTop < bBottom && bTop < aBottom;
  },

  // 与同孔既有已形成层位的区间重叠检查；excludeId 用于复核时排除自身
  overlapping(samples, borehole, topText, bottomText, excludeId) {
    const top = this.parseDepth(topText);
    const bottom = this.parseDepth(bottomText);
    if (top === null || bottom === null || top >= bottom) return null;
    return samples.find((s) =>
      s.id !== excludeId &&
      s.borehole === borehole &&
      s.layerTop !== null && s.layerBottom !== null &&
      s.layerTop < s.layerBottom &&
      this.intervalsOverlap(top, bottom, s.layerTop, s.layerBottom)
    ) || null;
  },

  // 判定一次登记/更正：返回缺陷与重叠对象（不改任何数据）
  judge(draft, samples, excludeId = null) {
    const issues = this.ownIssues(draft);
    const conflict = this.overlapping(
      samples, draft.borehole, draft.layerTopText, draft.layerBottomText, excludeId
    );
    return { issues, conflict };
  },

  // 同孔相邻层：在“可参与对照与导出”的有效层位内按深度排序后取上下邻居。
  // 筛选、卡片提示、刷新全部经由 Query 调用本函数，不会各算各的。
  neighbors(samples, sample) {
    const layers = samples
      .filter((s) =>
        s.status === "active" &&
        s.id !== sample.id &&
        s.borehole === sample.borehole &&
        s.layerTop !== null && s.layerBottom !== null &&
        s.layerTop < s.layerBottom
      )
      .sort((a, b) => a.layerTop - b.layerTop || a.layerBottom - b.layerBottom || a.code.localeCompare(b.code));
    return {
      upper: layers.filter((s) => s.layerBottom <= sample.layerTop).pop() || null,
      lower: layers.find((s) => s.layerTop >= sample.layerBottom) || null
    };
  }
};

/* ------------------------------------------------------------------ *
 * 查询管线：筛选、相邻层提示、导出次序、刷新结果一致的唯一来源
 * ------------------------------------------------------------------ */
const Query = {
  filters() {
    return {
      mineral: document.querySelector("#mineralFilter").value.trim(),
      borehole: document.querySelector("#boreholeFilter").value.trim(),
      status: document.querySelector("#statusFilter").value,
      polarization: document.querySelector("#polarFilter").value
    };
  },

  match(sample, f) {
    return (!f.mineral || (sample.minerals || "").includes(f.mineral)) &&
           (!f.borehole || (sample.borehole || "").includes(f.borehole)) &&
           (!f.status || sample.status === f.status) &&
           (!f.polarization || sample.polarization === f.polarization);
  },

  // 完整快照：一次计算，渲染、提示、导出都用它
  snapshot(filters = this.filters()) {
    const exportable = Repository.state.samples.filter((s) => s.status === "active");
    const exportOrder = this.exportOrderOf(exportable);

    const rows = Repository.state.samples
      .filter((s) => this.match(s, filters))
      .map((s) => {
        const row = { ...s };
        if (s.status === "active" && s.layerTop !== null) {
          row.exportSeq = exportOrder.indexOf(s.id) + 1;
          row.neighbors = Positioning.neighbors(Repository.state.samples, s);
        }
        return row;
      });
    return { rows, exportable, exportOrder, filters };
  },

  // 导出次序：按钻孔 → 层顶（浅→深）→ 层底 → 编号，重算而非存储
  exportOrderOf(activeSamples) {
    return [...activeSamples]
      .sort((a, b) =>
        (a.borehole || "").localeCompare(b.borehole || "") ||
        a.layerTop - b.layerTop ||
        a.layerBottom - b.layerBottom ||
        a.code.localeCompare(b.code)
      )
      .map((s) => s.id);
  }
};

/* ------------------------------------------------------------------ *
 * 构造 / 改写记录（控制器把 Intake 草稿 + Positioning 判定合成记录，
 * 再交给 Repository 保存）
 * ------------------------------------------------------------------ */
function buildRecord(draft) {
  const { issues } = Positioning.judge(draft, Repository.state.samples);
  return {
    id: crypto.randomUUID(),
    photo: draft.photo || "",
    code: draft.code,
    borehole: draft.borehole,
    collector: draft.collector,
    layerTop: Positioning.parseDepth(draft.layerTopText),
    layerBottom: Positioning.parseDepth(draft.layerBottomText),
    rockLayer: draft.rockLayer,
    location: draft.location,
    magnification: draft.magnification,
    polarization: draft.polarization,
    minerals: draft.minerals,
    texture: draft.texture,
    comment: draft.comment,
    status: issues.length ? "pending" : "active",
    issues,
    reviewed: null,
    corrections: [],
    createdAt: new Date().toISOString()
  };
}

// 层位字段（改动这些会让旧复核、对照选择、导出次序立即失效）
const HORIZON_FIELDS = ["borehole", "layerTop", "layerBottom", "rockLayer"];

function applyReview(base, input, photo) {
  const draft = {
    photo: photo != null ? photo : base.photo,
    borehole: input.borehole,
    layerTopText: input.layerTopText,
    layerBottomText: input.layerBottomText,
    rockLayer: input.rockLayer
  };
  const { issues, conflict } = Positioning.judge(draft, Repository.state.samples, base.id);

  // 同孔区间重叠：整条退回，旧记录原样保留
  if (conflict) return { ok: false, reason: "conflict", conflict, issues };

  const next = { ...base };
  next.photo = draft.photo;
  next.borehole = input.borehole;
  next.layerTop = Positioning.parseDepth(input.layerTopText);
  next.layerBottom = Positioning.parseDepth(input.layerBottomText);
  next.rockLayer = input.rockLayer;

  const horizonChanged = HORIZON_FIELDS.some((field) => {
    if (field === "layerTop" || field === "layerBottom") return next[field] !== base[field];
    return next[field] !== base[field];
  });

  const wasActive = base.status === "active";
  next.issues = issues;
  // “旧复核立即失效”只对已核销（active）记录的层位更正生效；
  // 待复核记录在复核中补齐层位不算更正，可直接换人核销。
  const horizonInvalidated = wasActive && horizonChanged;

  // 层位更正：旧复核立即失效，记录转入待复核，须换人（非采集人）重新核销；
  // 对照选择随之立即失效（由控制器移出），导出次序按新值重算。
  if (horizonInvalidated) {
    next.status = "pending";
    next.reviewed = null;
    next.corrections = [
      ...base.corrections,
      {
        at: new Date().toISOString(),
        by: base.reviewed ? base.reviewed.by : base.collector,
        note: input.note,
        borehole: base.borehole,
        layerTop: base.layerTop,
        layerBottom: base.layerBottom,
        rockLayer: base.rockLayer
      }
    ];
  } else {
    next.status = issues.length ? "pending" : "active";
    // 复核须换人：核销人不能与采集人相同
    if (next.status === "active") {
      if (!input.reviewer) return { ok: false, reason: "no-reviewer", next, issues };
      if (input.reviewer === next.collector) return { ok: false, reason: "same-person", next, issues };
      if (!base.reviewed || !wasActive) {
        next.reviewed = {
          by: input.reviewer,
          at: new Date().toISOString(),
          note: input.note
        };
      }
    }
  }

  return {
    ok: true,
    next,
    issues,
    horizonChanged: horizonInvalidated
  };
}

/* 旧数据迁移：没有归位信息的记录先进入待复核 */
function normalize(s) {
  const layerTop = s.layerTop === undefined ? Positioning.parseDepth(s.layerTopText) : s.layerTop;
  const layerBottom = s.layerBottom === undefined ? Positioning.parseDepth(s.layerBottomText) : s.layerBottom;
  const base = {
    id: s.id,
    photo: s.photo || "",
    code: s.code || "",
    borehole: s.borehole || "",
    collector: s.collector || "",
    layerTop: layerTop === undefined ? null : layerTop,
    layerBottom: layerBottom === undefined ? null : layerBottom,
    rockLayer: s.rockLayer || "",
    location: s.location || "",
    magnification: s.magnification || "",
    polarization: s.polarization || "单偏光",
    minerals: s.minerals || "",
    texture: s.texture || "",
    comment: s.comment || "",
    status: s.status || "pending",
    issues: s.issues || [],
    reviewed: s.reviewed || null,
    corrections: s.corrections || [],
    createdAt: s.createdAt || new Date().toISOString()
  };
  if (!base.issues.length && base.status === "pending") {
    base.issues = Positioning.ownIssues(base);
  }
  return base;
}

/* ------------------------------------------------------------------ *
 * 视图
 * ------------------------------------------------------------------ */
const form = document.querySelector("#sampleForm");
const photoInput = document.querySelector("#photoInput");
const sampleGrid = document.querySelector("#sampleGrid");
const comparePane = document.querySelector("#comparePane");
const mineralFilter = document.querySelector("#mineralFilter");
const boreholeFilter = document.querySelector("#boreholeFilter");
const statusFilter = document.querySelector("#statusFilter");
const polarFilter = document.querySelector("#polarFilter");
const formNotice = document.querySelector("#formNotice");
const reviewQueue = document.querySelector("#reviewQueue");
const reviewerName = document.querySelector("#reviewerName");
const exportBtn = document.querySelector("#exportBtn");

let pendingPhoto = "";
let correctingId = null;
// 复核面板里选中的新照片（按记录 id 暂存）
const reviewPhotos = {};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

const depthText = (v) => (v === null || v === undefined ? "—" : `${v} m`);

function notice(el, text, ok = false) {
  el.hidden = false;
  el.textContent = text;
  el.className = `notice ${ok ? "notice-ok" : "notice-bad"}`;
}

function cardHtml(s) {
  const pending = s.status === "pending";
  const inCompare = Repository.state.compare.includes(s.id);
  const issueLine = pending
    ? `<p class="issues">待复核：${s.issues.map(esc).join("；") || "等待换人复核"}</p>`
    : "";
  const reviewLine = s.reviewed
    ? `<p class="stamp">核销：${esc(s.reviewed.by)} · ${new Date(s.reviewed.at).toLocaleString()}</p>`
    : "";
  let neighborLine = "";
  if (s.neighbors && (s.neighbors.upper || s.neighbors.lower)) {
    const up = s.neighbors.upper ? esc(s.neighbors.upper.code) : "无";
    const down = s.neighbors.lower ? esc(s.neighbors.lower.code) : "无";
    neighborLine = `<p class="neighbors">同孔相邻层：↑${up}　↓${down}</p>`;
  }
  return `
  <article class="sample-card ${pending ? "is-pending" : ""}" data-card="${s.id}">
    ${s.photo ? `<img src="${s.photo}" alt="${esc(s.code)}显微照片">` : "<div class=\"photo-placeholder\">缺图</div>"}
    <div class="sample-body">
      <h3>${esc(s.code)}
        <span class="badge ${pending ? "badge-pending" : "badge-active"}">${pending ? "待复核" : "已归位"}</span>
        ${!pending && s.exportSeq ? `<span class="seq">导出序 ${s.exportSeq}</span>` : ""}
      </h3>
      <p>${esc(s.borehole) || "未登记钻孔"} · ${depthText(s.layerTop)}–${depthText(s.layerBottom)}</p>
      <p>岩层：${esc(s.rockLayer) || "未判"} · 采集：${esc(s.collector) || "未登记"}</p>
      <p>${esc(s.location) || "未记录地点"} · ${esc(s.magnification) || "未记录倍数"} · ${esc(s.polarization)}</p>
      <p>矿物：${esc(s.minerals) || "未记录"}</p>
      <p>结构：${esc(s.texture) || "未记录"}</p>
      <p>${esc(s.comment) || "未填写批注"}</p>
      ${neighborLine}
      ${issueLine}
      ${reviewLine}
      <div class="card-actions">
        <label>${pending
          ? `<input type="checkbox" disabled title="待复核记录不能参与对照">`
          : `<input type="checkbox" data-compare="${s.id}" ${inCompare ? "checked" : ""}>`}对比</label>
        <button type="button" data-correct="${s.id}">${pending ? "去复核" : "层位更正"}</button>
        <button type="button" data-delete="${s.id}">删除</button>
      </div>
    </div>
  </article>`;
}

function reviewItemHtml(s) {
  const correcting = correctingId === s.id;
  const isActive = s.status === "active";
  const photoBlock = correcting
    ? `<div class="review-photo">
         ${s.photo ? `<img src="${s.photo}" alt="${esc(s.code)}">` : "<p class=\"issues\">当前缺图，请补显微照片</p>"}
         <input type="file" accept="image/*" data-r-photo>
         <p class="review-photo-hint" hidden></p>
       </div>`
    : (s.photo ? `<img class="review-thumb" src="${s.photo}" alt="">` : "<div class=\"photo-placeholder small\">缺图</div>");
  return `
  <article class="review-item ${correcting ? "is-correcting" : ""}" data-review-card="${s.id}">
    ${photoBlock}
    <h4>${esc(s.code)} <span class="badge ${isActive ? "badge-active" : "badge-pending"}">${isActive ? "层位更正" : "待复核"}</span></h4>
    <p class="issues">${s.issues.map(esc).join("；") || (isActive ? "已归位，可发起层位更正" : "已补齐，等待换人核销")}</p>
    ${correcting ? `
      <label>钻孔<input data-r-borehole value="${esc(s.borehole)}"></label>
      <label>采集人（不可改）<input data-r-collector value="${esc(s.collector)}" readonly></label>
      <div class="pair">
        <label>层顶(m)<input data-r-top inputmode="decimal" value="${s.layerTop ?? ""}"></label>
        <label>层底(m)<input data-r-bottom inputmode="decimal" value="${s.layerBottom ?? ""}"></label>
      </div>
      <label>岩层<input data-r-rock value="${esc(s.rockLayer)}" placeholder="未判请留空"></label>
      <label>核销意见<textarea data-r-note rows="2" placeholder="改动钻孔/层顶/层底/岩层后旧复核立即失效，须由非采集人重新核销"></textarea></label>
      <p class="review-msg notice" hidden></p>
      <div class="review-btns">
        <button type="button" data-r-submit>${isActive ? "保存层位更正" : "提交核销 / 更正"}</button>
        <button type="button" class="ghost" data-r-cancel>取消</button>
      </div>` : `
      <p>${esc(s.borehole)} · ${depthText(s.layerTop)}–${depthText(s.layerBottom)} · 岩层：${esc(s.rockLayer) || "未判"}</p>
      <p>采集人：${esc(s.collector)}</p>`}
  </article>`;
}

function renderBoard() {
  const snap = Query.snapshot();
  sampleGrid.innerHTML = snap.rows.length
    ? snap.rows.map(cardHtml).join("")
    : "<p>没有符合筛选条件的薄片记录。</p>";

  const compareSamples = Repository.state.compare
    .map((id) => Repository.state.samples.find((s) => s.id === id && s.status === "active"))
    .filter(Boolean)
    .slice(0, 2);
  comparePane.innerHTML = compareSamples.length ? compareSamples.map((s) => `
    <article class="compare-item">
      ${s.photo ? `<img src="${s.photo}" alt="${esc(s.code)}对比图">` : ""}
      <h3>${esc(s.code)}</h3>
      <p>${esc(s.borehole)} · ${depthText(s.layerTop)}–${depthText(s.layerBottom)}</p>
      <p>${esc(s.polarization)} · ${esc(s.rockLayer) || "未判岩层"}</p>
      <p>${esc(s.texture) || "未记录结构"}</p>
    </article>`).join("")
    : "<p>勾选两张已归位薄片后可并排对比（待复核不能参与）。</p>";

  // 可导出数量与实际导出一致：当前筛选条件下的已归位薄片
  const exportCount = snap.exportOrder
    .filter((id) => snap.rows.some((row) => row.id === id)).length;
  exportBtn.textContent = `导出观察清单（${exportCount} 片可导出）`;
}

function renderReviews() {
  // 复核队列不受板上筛选影响；正在对已归位记录做层位更正时也纳入队列展开
  const pendingIds = new Set(
    Repository.state.samples.filter((s) => s.status === "pending").map((s) => s.id)
  );
  if (correctingId) pendingIds.add(correctingId);
  const pending = Repository.state.samples
    .filter((s) => pendingIds.has(s.id))
    .sort((a, b) => (a.borehole || "").localeCompare(b.borehole || "") ||
                    (a.layerTop ?? Infinity) - (b.layerTop ?? Infinity) ||
                    a.code.localeCompare(b.code));
  reviewQueue.innerHTML = pending.length
    ? pending.map(reviewItemHtml).join("")
    : "<p class=\"empty\">没有待复核记录，交接清单已全部核销。</p>";
}

function refreshAll() {
  renderBoard();
  renderReviews();
}

/* ------------------------------------------------------------------ *
 * 录入：Intake 读表单 → Positioning 判定 → Repository 保存
 * ------------------------------------------------------------------ */
photoInput.addEventListener("change", async () => {
  pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pendingPhoto && photoInput.files[0]) {
    pendingPhoto = await readFileAsDataUrl(photoInput.files[0]);
  }

  const draft = Intake.fromForm(form, pendingPhoto);
  const { issues, conflict } = Positioning.judge(draft, Repository.state.samples);

  // 同孔区间重叠：整条退回，不保存，原记录全部保留
  if (conflict) {
    notice(formNotice,
      `登记退回：${draft.borehole} 孔 ${draft.layerTopText}–${draft.layerBottomText}m 与已登记的 ${conflict.code}（${conflict.layerTop}–${conflict.layerBottom}m）层位区间重叠，原记录保留，本条未保存。`);
    return;
  }

  Repository.add(buildRecord(draft));

  pendingPhoto = "";
  photoInput.value = "";
  form.reset();
  notice(formNotice,
    issues.length
      ? `已登记并进待复核（${issues.join("；")}），补齐后须换人复核核销；待复核记录不能参与对照与导出。`
      : "归位成功，记录已登记并可参与对照与导出。",
    !issues.length);
  refreshAll();
});

/* ------------------------------------------------------------------ *
 * 列表交互：删除 / 对照 / 去复核·层位更正
 * ------------------------------------------------------------------ */
sampleGrid.addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn) return;
  const deleteId = btn.dataset.delete;
  const correctId = btn.dataset.correct;
  if (deleteId) {
    Repository.remove(deleteId);
    delete reviewPhotos[deleteId];
    if (correctingId === deleteId) correctingId = null;
    refreshAll();
  } else if (correctId) {
    correctingId = correctingId === correctId ? null : correctId;
    renderReviews();
    const card = reviewQueue.querySelector(`[data-review-card="${correctId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1200);
    }
  }
});

sampleGrid.addEventListener("change", (event) => {
  const id = event.target.dataset.compare;
  if (!id) return;
  // 待复核记录的复选框处于禁用态，此处只可能是已归位记录
  if (event.target.checked) {
    Repository.setCompare([id, ...Repository.state.compare.filter((x) => x !== id)].slice(0, 2));
  } else {
    Repository.setCompare(Repository.state.compare.filter((x) => x !== id));
  }
  renderBoard();
});

/* ------------------------------------------------------------------ *
 * 交接核销面板：换人复核、层位更正
 * ------------------------------------------------------------------ */
reviewQueue.addEventListener("click", (event) => {
  const card = event.target.closest("[data-review-card]");
  if (!card) return;
  const id = card.dataset.reviewCard;

  if (event.target.closest("[data-r-cancel]")) {
    if (correctingId === id) correctingId = null;
    delete reviewPhotos[id];
    renderReviews();
    return;
  }

  if (!event.target.closest("[data-r-submit]")) return;

  const base = Repository.state.samples.find((s) => s.id === id);
  if (!base) return;

  const input = Intake.fromReview(card);
  // 复核人来自“交接核销”面板顶部的公共输入
  const finalInput = { ...input, reviewer: reviewerName.value.trim() };

  if (!finalInput.borehole) {
    showReviewMsg(card, "钻孔编号不能为空。");
    return;
  }

  const result = applyReview(base, finalInput, reviewPhotos[id] ?? null);

  if (!result.ok && result.reason === "conflict") {
    // 区间重叠：整条退回，旧记录原样保留（输入也不清空，便于调整）
    showReviewMsg(card,
      `更正退回：与同孔 ${result.conflict.code}（${result.conflict.layerTop}–${result.conflict.layerBottom}m）层位重叠，原记录保留。`);
    return;
  }
  if (!result.ok && result.reason === "no-reviewer") {
    showReviewMsg(card, "请填写复核人（复核须换人）。");
    return;
  }
  if (!result.ok && result.reason === "same-person") {
    showReviewMsg(card, `复核人不能与采集人「${result.next.collector}」相同，请换人核销。`);
    return;
  }

  // 层位更正立即使旧复核、对照选择、导出次序失效：先移出对照，再保存新值
  if (result.horizonChanged && Repository.state.compare.includes(id)) {
    Repository.setCompare(Repository.state.compare.filter((x) => x !== id));
  }

  Repository.replace(id, result.next);
  delete reviewPhotos[id];
  const stillPending = result.next.status === "pending";
  if (!stillPending) correctingId = null;
  refreshAll();

  if (result.horizonChanged) {
    const nextCard = reviewQueue.querySelector(`[data-review-card="${id}"]`);
    if (nextCard) showReviewMsg(nextCard,
      `层位已更正并保存，旧复核与对照选择立即失效、导出次序已按新值重算；${result.issues.length ? `仍存在：${result.issues.join("；")}；` : ""}请由非采集人复核核销。`);
  } else if (stillPending) {
    const nextCard = reviewQueue.querySelector(`[data-review-card="${id}"]`);
    if (nextCard) showReviewMsg(nextCard,
      `已保存但仍待复核：${result.issues.join("；") || "请换人复核核销"}。`);
  }
});

// 复核面板补照片
reviewQueue.addEventListener("change", async (event) => {
  if (!event.target.matches("[data-r-photo]")) return;
  const card = event.target.closest("[data-review-card]");
  const id = card.dataset.reviewCard;
  const dataUrl = await readFileAsDataUrl(event.target.files[0]);
  reviewPhotos[id] = dataUrl;
  const hint = card.querySelector(".review-photo-hint");
  if (hint) {
    hint.hidden = false;
    hint.textContent = "已选择新照片，提交后生效。";
  }
});

function showReviewMsg(card, text) {
  const msg = card.querySelector(".review-msg");
  if (msg) notice(msg, text);
}

/* 筛选、相邻层提示与刷新共用 Query.snapshot，保证结果一致 */
[mineralFilter, boreholeFilter, statusFilter, polarFilter]
  .forEach((field) => field.addEventListener("input", renderBoard));

/* ------------------------------------------------------------------ *
 * 导出：只导出已归位核销、且符合当前筛选的薄片，次序即时重算
 * ------------------------------------------------------------------ */
exportBtn.addEventListener("click", () => {
  const snap = Query.snapshot();
  const order = snap.exportOrder;
  const checklist = order
    .map((id, i) => {
      const s = snap.rows.find((row) => row.id === id);
      if (!s) return null;
      return {
        导出次序: i + 1,
        样本编号: s.code,
        钻孔编号: s.borehole,
        层顶深度_m: s.layerTop,
        层底深度_m: s.layerBottom,
        岩层: s.rockLayer,
        采集人: s.collector,
        复核人: s.reviewed ? s.reviewed.by : "",
        采样地点: s.location,
        放大倍数: s.magnification,
        偏光类型: s.polarization,
        主要矿物: s.minerals,
        颗粒结构: s.texture,
        老师批注: s.comment
      };
    })
    .filter(Boolean);

  const blob = new Blob([JSON.stringify(checklist, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "core-thin-section-checklist.json";
  link.click();
  URL.revokeObjectURL(link.href);
});

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) return resolve("");
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.readAsDataURL(file);
  });
}

refreshAll();
