/* ==========================================================================
 * 岩芯薄片索引台 —— 钻孔分层归位与交接核销
 * 三个独立业务部分：
 *   ① Entry     录入：读取表单、组装登记草稿并提交
 *   ② Placement 归位判定：区间校验、同孔重叠退回、相邻层与导出次序
 *   ③ Store     保存：状态持有与本地持久化
 * 界面层只做筛选、相邻层提示与刷新，三者共用同一份状态。
 * ========================================================================== */

/* ---------- 业务部分②：归位判定（纯函数，不触碰界面与存储） ---------- */
const Placement = (() => {
  function isValidInterval(sample) {
    return Number.isFinite(sample.layerTop)
      && Number.isFinite(sample.layerBottom)
      && sample.layerTop < sample.layerBottom;
  }

  function rockUndecided(rockLayer) {
    const value = (rockLayer || "").trim();
    return !value || value === "未判";
  }

  // 缺图、层顶不低于层底、岩层未判 → 只进待复核
  function validityReasons(sample) {
    const reasons = [];
    if (!sample.photo) reasons.push("缺图");
    if (!isValidInterval(sample)) reasons.push("层顶不低于层底");
    if (rockUndecided(sample.rockLayer)) reasons.push("岩层未判");
    return reasons;
  }

  // 同孔区间重叠（端点相接不算重叠，视为相邻层）
  function intervalsOverlap(a, b) {
    return a.borehole === b.borehole
      && isValidInterval(a) && isValidInterval(b)
      && a.layerTop < b.layerBottom
      && b.layerTop < a.layerBottom;
  }

  // 归位判定：placed 归位 / pending 待复核 / rejected 整条退回
  function assess(draft, samples, excludeId = null) {
    const conflict = samples.find((sample) => sample.id !== excludeId && intervalsOverlap(draft, sample));
    if (conflict) {
      return { decision: "rejected", conflict, reasons: [`与 ${conflict.code} 区间重叠`] };
    }
    const reasons = validityReasons(draft);
    return reasons.length
      ? { decision: "pending", reasons }
      : { decision: "placed", reasons: [] };
  }

  function byBoreholeThenTop(a, b) {
    return (a.borehole || "").localeCompare(b.borehole || "", "zh-Hans-CN", { numeric: true })
      || a.layerTop - b.layerTop
      || (a.code || "").localeCompare(b.code || "");
  }

  // 已归位序列：对照、相邻层提示与导出共用同一次序
  function placedSequence(samples) {
    return samples
      .filter((sample) => sample.status === "active" && isValidInterval(sample))
      .sort(byBoreholeThenTop);
  }

  // 相邻层提示：同孔内按层顶排序取上下邻
  function adjacency(samples) {
    const hints = new Map();
    const sequence = placedSequence(samples);
    sequence.forEach((sample, index) => {
      const prev = sequence[index - 1];
      const next = sequence[index + 1];
      hints.set(sample.id, {
        prev: prev && prev.borehole === sample.borehole ? prev : null,
        next: next && next.borehole === sample.borehole ? next : null
      });
    });
    return hints;
  }

  // 导出次序：仅已归位样本参与，按钻孔与层顶实时重算
  function exportOrder(samples) {
    return placedSequence(samples);
  }

  return { isValidInterval, rockUndecided, validityReasons, intervalsOverlap, assess, adjacency, exportOrder };
})();

/* ---------- 业务部分③：保存（状态与持久化，不做归位判断） ---------- */
const Store = (() => {
  const key = "wxyy-2-thin-section-index";
  const state = load();

  function defaults() {
    return {
      borehole: "",
      layerTop: null,
      layerBottom: null,
      collector: "",
      rockLayer: "",
      status: "active",
      pendingReasons: [],
      reviewedBy: ""
    };
  }

  function normalize(sample) {
    const merged = { ...defaults(), ...sample };
    if (!sample.status) {
      // 旧数据迁移：按现行规则补判归位状态
      const reasons = Placement.validityReasons(merged);
      merged.status = reasons.length ? "pending" : "active";
      merged.pendingReasons = reasons;
    }
    return merged;
  }

  function load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "{}");
      return {
        samples: Array.isArray(parsed.samples) ? parsed.samples.map(normalize) : [],
        compare: Array.isArray(parsed.compare) ? parsed.compare : []
      };
    } catch {
      return { samples: [], compare: [] };
    }
  }

  function save() {
    localStorage.setItem(key, JSON.stringify(state));
  }

  function add(sample) {
    state.samples.unshift(sample);
    save();
  }

  function update(id, patch) {
    const target = state.samples.find((sample) => sample.id === id);
    if (target) Object.assign(target, patch);
    save();
  }

  function remove(id) {
    state.samples = state.samples.filter((sample) => sample.id !== id);
    state.compare = state.compare.filter((item) => item !== id);
    save();
  }

  function setCompare(ids) {
    state.compare = ids;
    save();
  }

  function dropFromCompare(id) {
    state.compare = state.compare.filter((item) => item !== id);
    save();
  }

  return { state, save, add, update, remove, setCompare, dropFromCompare };
})();

/* ---------- 业务部分①：录入（表单读取与登记提交） ---------- */
const Entry = (() => {
  let pendingPhoto = "";

  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      if (!file) return resolve("");
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result));
      reader.readAsDataURL(file);
    });
  }

  function setPhoto(file) {
    return readFileAsDataUrl(file).then((dataUrl) => {
      pendingPhoto = dataUrl;
    });
  }

  function clearPhoto() {
    pendingPhoto = "";
  }

  // 每片登记：钻孔、层顶、层底、采集人、岩层
  function readDraft(form) {
    const data = new FormData(form);
    return {
      photo: pendingPhoto,
      code: data.get("code").trim(),
      borehole: data.get("borehole").trim(),
      layerTop: parseFloat(data.get("layerTop")),
      layerBottom: parseFloat(data.get("layerBottom")),
      collector: data.get("collector").trim(),
      rockLayer: data.get("rockLayer").trim(),
      location: data.get("location").trim(),
      magnification: data.get("magnification").trim(),
      polarization: data.get("polarization"),
      minerals: data.get("minerals").trim(),
      texture: data.get("texture").trim(),
      comment: data.get("comment").trim()
    };
  }

  // 提交登记：归位判定决定 归位 / 待复核 / 整条退回
  async function submit(form, photoFile) {
    if (!pendingPhoto && photoFile) {
      pendingPhoto = await readFileAsDataUrl(photoFile);
    }
    const draft = readDraft(form);
    const verdict = Placement.assess(draft, Store.state.samples);
    if (verdict.decision === "rejected") {
      const conflict = verdict.conflict;
      return {
        ok: false,
        message: `整条退回：${draft.borehole} 孔 ${draft.layerTop}–${draft.layerBottom}m 与已登记的 ${conflict.code}（${conflict.layerTop}–${conflict.layerBottom}m）区间重叠，原记录保留。`
      };
    }
    Store.add({
      id: crypto.randomUUID(),
      ...draft,
      status: verdict.decision === "placed" ? "active" : "pending",
      pendingReasons: verdict.reasons,
      reviewedBy: "",
      createdAt: new Date().toISOString()
    });
    return verdict.decision === "placed"
      ? { ok: true, message: `${draft.code} 已归位保存。` }
      : { ok: true, message: `${draft.code} 登记为待复核：${verdict.reasons.join("；")}。复核通过前不参与对照与导出。` };
  }

  return { setPhoto, clearPhoto, submit };
})();

/* ---------- 界面层：筛选、相邻层提示与刷新共用同一数据源 ---------- */
const form = document.querySelector("#sampleForm");
const photoInput = document.querySelector("#photoInput");
const sampleGrid = document.querySelector("#sampleGrid");
const comparePane = document.querySelector("#comparePane");
const mineralFilter = document.querySelector("#mineralFilter");
const polarFilter = document.querySelector("#polarFilter");
const noticeEl = document.querySelector("#notice");

let editingId = null;
let noticeText = "";

function setNotice(text) {
  noticeText = text;
}

function filteredSamples() {
  const mineral = mineralFilter.value.trim();
  const polarization = polarFilter.value;
  return Store.state.samples.filter((sample) => {
    const mineralMatch = !mineral || sample.minerals.includes(mineral);
    const polarMatch = !polarization || sample.polarization === polarization;
    return mineralMatch && polarMatch;
  });
}

function depthText(sample) {
  return Placement.isValidInterval(sample)
    ? `${sample.layerTop}–${sample.layerBottom}m`
    : "层位待定";
}

function neighborText(sample) {
  return sample ? `${sample.code} ${depthText(sample)}` : "无";
}

function adjacentText(hint) {
  if (!hint) return "相邻层：未归位，暂无提示";
  return `相邻层 上：${neighborText(hint.prev)} ｜ 下：${neighborText(hint.next)}`;
}

function cardHtml(sample, hints) {
  const photo = sample.photo
    ? `<img src="${sample.photo}" alt="${sample.code}显微照片">`
    : `<div class="photo-placeholder">缺图</div>`;
  const badge = sample.status === "pending"
    ? '<span class="badge pending">待复核</span>'
    : '<span class="badge ok">已归位</span>';
  const head = `
    <h3>${sample.code} ${badge}</h3>
    <p>${sample.borehole || "未登记钻孔"} 孔 · ${depthText(sample)} · 岩层：${sample.rockLayer || "未判"}</p>
    <p>采集：${sample.collector || "未登记"}${sample.reviewedBy ? ` · 复核：${sample.reviewedBy}` : ""}</p>
    <p>${sample.location || "未记录地点"} · ${sample.magnification || "未记录倍数"} · ${sample.polarization}</p>
    <p>矿物：${sample.minerals || "未记录"}</p>
    <p>结构：${sample.texture || "未记录"}</p>
    <p>${sample.comment || "未填写批注"}</p>
  `;

  if (sample.status === "pending") {
    return `
    <article class="sample-card pending">
      ${photo}
      <div class="sample-body">
        ${head}
        <p>待复核原因：${(sample.pendingReasons || []).join("；") || "待复核"}</p>
        <p class="adjacent">待复核样本暂不归位，不参与对照与导出。</p>
        <div class="review-box">
          <input name="reviewer" placeholder="复核人（须与采集人不同）">
          <div class="pair">
            <input name="layerTop" type="number" step="0.01" placeholder="层顶(m)" value="${sample.layerTop ?? ""}">
            <input name="layerBottom" type="number" step="0.01" placeholder="层底(m)" value="${sample.layerBottom ?? ""}">
          </div>
          <input name="rockLayer" placeholder="岩层判定" value="${sample.rockLayer || ""}">
          <button type="button" data-review="${sample.id}">复核归位</button>
        </div>
        <div class="card-actions">
          <span></span>
          <button type="button" data-delete="${sample.id}">删除</button>
        </div>
      </div>
    </article>`;
  }

  if (editingId === sample.id) {
    return `
    <article class="sample-card">
      ${photo}
      <div class="sample-body">
        ${head}
        <div class="edit-box">
          <input name="borehole" placeholder="钻孔编号" value="${sample.borehole || ""}">
          <div class="pair">
            <input name="layerTop" type="number" step="0.01" placeholder="层顶(m)" value="${sample.layerTop ?? ""}">
            <input name="layerBottom" type="number" step="0.01" placeholder="层底(m)" value="${sample.layerBottom ?? ""}">
          </div>
          <input name="rockLayer" placeholder="岩层" value="${sample.rockLayer || ""}">
          <div class="pair">
            <button type="button" data-save-edit="${sample.id}">保存更正</button>
            <button type="button" data-cancel-edit>取消</button>
          </div>
        </div>
      </div>
    </article>`;
  }

  return `
  <article class="sample-card">
    ${photo}
    <div class="sample-body">
      ${head}
      <p class="adjacent">${adjacentText(hints.get(sample.id))}</p>
      <div class="card-actions">
        <label><input type="checkbox" data-compare="${sample.id}" ${Store.state.compare.includes(sample.id) ? "checked" : ""}>对比</label>
        <button type="button" data-edit="${sample.id}">层位更正</button>
        <button type="button" data-delete="${sample.id}">删除</button>
      </div>
    </div>
  </article>`;
}

function render() {
  const rows = filteredSamples();
  const hints = Placement.adjacency(Store.state.samples);
  sampleGrid.innerHTML = rows.length
    ? rows.map((sample) => cardHtml(sample, hints)).join("")
    : "<p>还没有样本，先从左侧录入一张薄片照片。</p>";

  const compareSamples = Store.state.compare
    .map((id) => Store.state.samples.find((sample) => sample.id === id))
    .filter((sample) => sample && sample.status === "active")
    .slice(0, 2);

  comparePane.innerHTML = compareSamples.length ? compareSamples.map((sample) => `
    <article class="compare-item">
      ${sample.photo ? `<img src="${sample.photo}" alt="${sample.code}对比图">` : ""}
      <h3>${sample.code}</h3>
      <p>${sample.borehole} 孔 · ${depthText(sample)} · ${sample.rockLayer}</p>
      <p>${sample.polarization} · ${sample.minerals || "未记录矿物"}</p>
      <p>${sample.texture || "未记录结构"}</p>
    </article>
  `).join("") : "<p>勾选两张已归位样本卡片后可并排对比。</p>";

  noticeEl.hidden = !noticeText;
  noticeEl.textContent = noticeText;
}

function handleReview(id, card) {
  const sample = Store.state.samples.find((item) => item.id === id);
  if (!sample) return;
  const reviewer = card.querySelector('[name="reviewer"]').value.trim();
  const patch = {
    layerTop: parseFloat(card.querySelector('[name="layerTop"]').value),
    layerBottom: parseFloat(card.querySelector('[name="layerBottom"]').value),
    rockLayer: card.querySelector('[name="rockLayer"]').value.trim()
  };
  if (!reviewer) {
    setNotice("请填写复核人，复核须换人完成。");
    render();
    return;
  }
  if (reviewer === sample.collector) {
    setNotice("复核须换人：复核人不能与采集人相同。");
    render();
    return;
  }
  const verdict = Placement.assess({ ...sample, ...patch }, Store.state.samples, id);
  if (verdict.decision === "rejected") {
    setNotice(`更正未保存：${sample.borehole} 孔新区间与 ${verdict.conflict.code}（${verdict.conflict.layerTop}–${verdict.conflict.layerBottom}m）重叠，保留原记录。`);
    render();
    return;
  }
  if (verdict.decision === "pending") {
    Store.update(id, { ...patch, pendingReasons: verdict.reasons });
    setNotice(`仍待复核：${verdict.reasons.join("；")}。`);
    render();
    return;
  }
  Store.update(id, { ...patch, status: "active", pendingReasons: [], reviewedBy: reviewer });
  setNotice(`${sample.code} 已由 ${reviewer} 复核归位，可参与对照与导出。`);
  render();
}

function handleSaveEdit(id, card) {
  const sample = Store.state.samples.find((item) => item.id === id);
  if (!sample) return;
  const patch = {
    borehole: card.querySelector('[name="borehole"]').value.trim(),
    layerTop: parseFloat(card.querySelector('[name="layerTop"]').value),
    layerBottom: parseFloat(card.querySelector('[name="layerBottom"]').value),
    rockLayer: card.querySelector('[name="rockLayer"]').value.trim()
  };
  const verdict = Placement.assess({ ...sample, ...patch }, Store.state.samples, id);
  if (verdict.decision === "rejected") {
    editingId = null;
    setNotice(`更正被退回：与 ${verdict.conflict.code}（${verdict.conflict.layerTop}–${verdict.conflict.layerBottom}m）区间重叠，保留原层位。`);
    render();
    return;
  }
  // 层位更正：旧复核与对照选择立即失效，回到待复核，导出次序按新值重算
  Store.update(id, {
    ...patch,
    status: "pending",
    pendingReasons: verdict.reasons.length ? verdict.reasons : ["层位更正，待重新复核"],
    reviewedBy: ""
  });
  Store.dropFromCompare(id);
  editingId = null;
  setNotice("层位已更正：旧复核与对照选择已失效，导出次序按新层位重算。");
  render();
}

photoInput.addEventListener("change", () => Entry.setPhoto(photoInput.files[0]));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await Entry.submit(form, photoInput.files[0]);
  if (result.ok) {
    Entry.clearPhoto();
    photoInput.value = "";
    form.reset();
  }
  setNotice(result.message);
  render();
});

sampleGrid.addEventListener("click", (event) => {
  const deleteId = event.target.dataset.delete;
  if (deleteId) {
    Store.remove(deleteId);
    setNotice("已删除样本。");
    render();
    return;
  }
  const editId = event.target.dataset.edit;
  if (editId) {
    editingId = editId;
    render();
    return;
  }
  if ("cancelEdit" in event.target.dataset) {
    editingId = null;
    render();
    return;
  }
  const reviewId = event.target.dataset.review;
  if (reviewId) {
    handleReview(reviewId, event.target.closest(".sample-card"));
    return;
  }
  const saveEditId = event.target.dataset.saveEdit;
  if (saveEditId) {
    handleSaveEdit(saveEditId, event.target.closest(".sample-card"));
  }
});

sampleGrid.addEventListener("change", (event) => {
  const id = event.target.dataset.compare;
  if (!id) return;
  if (event.target.checked) {
    const sample = Store.state.samples.find((item) => item.id === id);
    if (!sample || sample.status !== "active") return;
    Store.setCompare([id, ...Store.state.compare.filter((item) => item !== id)].slice(0, 2));
  } else {
    Store.setCompare(Store.state.compare.filter((item) => item !== id));
  }
  render();
});

[mineralFilter, polarFilter].forEach((field) => field.addEventListener("input", render));

document.querySelector("#exportBtn").addEventListener("click", () => {
  const placed = Placement.exportOrder(Store.state.samples);
  const pendingCount = Store.state.samples.length - placed.length;
  const checklist = placed.map((sample) => ({
    样本编号: sample.code,
    钻孔: sample.borehole,
    "层顶(m)": sample.layerTop,
    "层底(m)": sample.layerBottom,
    岩层: sample.rockLayer,
    采集人: sample.collector,
    复核人: sample.reviewedBy,
    采样地点: sample.location,
    放大倍数: sample.magnification,
    偏光类型: sample.polarization,
    主要矿物: sample.minerals,
    颗粒结构: sample.texture,
    老师批注: sample.comment
  }));
  const blob = new Blob([JSON.stringify(checklist, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "thin-section-checklist.json";
  link.click();
  URL.revokeObjectURL(link.href);
  setNotice(`已导出 ${placed.length} 条已归位样本${pendingCount ? `，${pendingCount} 条待复核未参与` : ""}。`);
  render();
});

render();
