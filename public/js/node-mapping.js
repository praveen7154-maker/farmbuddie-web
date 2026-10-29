/* Node Mapping - the nodes (motor node, valve nodes ...) a farm has, each by
 * its serial. Inside the MCU / Device Mapping card of onboarding, Add Farm
 * and Edit Farm: "Add node" adds a row - the type, then the serial, chosen
 * from the nodes nobody has yet (made on the Production page, "nodes"
 * collection, id = serial). As many rows as the farm needs.
 *
 * Stored on the farm doc as farmers/<id>.nodes = [{ type, serialNumber }];
 * each node doc gets status "assigned" + the farm (farmerDocId, farmerId),
 * like a controller, and leaves the choice for every other farm. Taking a
 * node off a farm (Edit) makes it "available" again. Both are written in
 * one transaction with the farm's list, so a node is never on two farms. */
import {
  collection, query, where, getDocs, getDoc, doc, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { NODE_TYPES, nodeTypeName } from "/js/node-types.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cleanSerial = (v) => String(v || "").replace(/\s+/g, "").toUpperCase();
let uid = 0;

/**
 * Puts the Node Mapping block in `container` (an element or its id).
 * -> { fill(nodes), read() -> { nodes, error }, check() -> Promise<error|null>, save({ farmerDocId, farmBuddieId }) }
 */
export function createNodeMapping(container, db) {
  const root = typeof container === "string" ? document.getElementById(container) : container;
  if (!root) return null;
  const id = `nm${++uid}`;
  root.classList.add("nm");
  root.innerHTML = `
    <div class="nm-head">
      <h2 class="sub-section-title">🔗 Node Mapping</h2>
      <span class="nm-count" id="${id}Count"></span>
      <button type="button" class="nm-add" id="${id}Add">＋ Add node</button>
    </div>
    <p class="nm-hint">One row per node the farmer bought - choose the type, then its serial (or scan its QR label into the serial box). Only nodes not on another farm are offered.</p>
    <div class="nm-rows" id="${id}Rows"></div>
    <p class="nm-empty" id="${id}Empty">No nodes on this farm. Tap <b>Add node</b> for each motor node, valve node … the farmer bought.</p>`;
  const rowsBox = root.querySelector(".nm-rows");

  let available = null;        // type -> [serial], the nodes nobody has (loaded once)
  let loading = null;
  let own = [];                // [{ type, serialNumber }] already on this farm (Edit) - offered again
  let previous = [];           // what the farm had when the page opened

  function load() {
    if (!loading) {
      loading = getDocs(query(collection(db, "nodes"), where("status", "==", "available")))
        .then((snap) => {
          available = Object.fromEntries(NODE_TYPES.map((t) => [t.type, []]));
          snap.forEach((d) => {
            const n = d.data();
            if (available[n.type]) available[n.type].push(n.serialNumber || d.id);
          });
          for (const list of Object.values(available)) list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          refresh();
        })
        .catch((err) => {
          console.error("Node list load error:", err);
          loading = null;
          root.querySelector(".nm-hint").textContent = "Couldn't load the available nodes - check the connection and open this page again.";
        });
    }
    return loading;
  }

  // what a row may choose: this type's free nodes + this farm's own, minus the other rows' choices
  function choicesFor(type, row) {
    if (!type) return [];
    const taken = new Set(rows().filter((r) => r !== row).map((r) => serialOf(r)).filter(Boolean));
    const mine = own.filter((n) => n.type === type).map((n) => n.serialNumber);
    return [...new Set([...mine, ...(available?.[type] || [])])].filter((s) => !taken.has(s));
  }
  // which type a serial belongs to (a scanned QR with no type chosen yet)
  function typeOfSerial(sn) {
    const mine = own.find((n) => n.serialNumber === sn);
    if (mine) return mine.type;
    for (const [type, list] of Object.entries(available || {})) if (list.includes(sn)) return type;
    return null;
  }

  const rows = () => [...rowsBox.querySelectorAll(".nm-row")];
  const serialOf = (row) => cleanSerial(row.querySelector(".nm-serial").value);

  function addRow(type = "", serialNumber = "") {
    const n = ++uid;
    const row = document.createElement("div");
    row.className = "nm-row";
    row.innerHTML = `
      <span class="nm-n"></span>
      <select class="nm-type" aria-label="Node type">
        <option value="">Node type</option>
        ${NODE_TYPES.map((t) => `<option value="${t.type}">${esc(t.name)}</option>`).join("")}
      </select>
      <input class="nm-serial" list="nmList${n}" placeholder="Serial - type, pick or scan" autocomplete="off" spellcheck="false" aria-label="Node serial number">
      <datalist id="nmList${n}"></datalist>
      <button type="button" class="nm-del" aria-label="Remove this node" title="Remove">✕</button>
      <small class="nm-msg"></small>`;
    row.querySelector(".nm-type").value = type;
    row.querySelector(".nm-serial").value = serialNumber;
    rowsBox.appendChild(row);
    refresh();
    return row;
  }

  function refresh() {
    const list = rows();
    list.forEach((row, i) => {
      row.querySelector(".nm-n").textContent = i + 1;
      const type = row.querySelector(".nm-type").value;
      const choices = choicesFor(type, row);
      row.querySelector("datalist").innerHTML = choices.map((s) => `<option value="${esc(s)}">`).join("");
      const sel = row.querySelector(".nm-type");
      [...sel.options].forEach((o) => {
        if (!o.value) return;
        const n = available ? choicesFor(o.value, row).length : null;
        o.textContent = `${nodeTypeName(o.value)}${n === null ? "" : ` (${n} available)`}`;
      });
      row.querySelector(".nm-serial").placeholder = !type ? "Serial - type, pick or scan"
        : available && !choices.length ? "None available - make them in Production" : "Choose the serial";
    });
    const counts = {};
    for (const row of list) {
      const t = row.querySelector(".nm-type").value;
      if (t) counts[t] = (counts[t] || 0) + 1;
    }
    root.querySelector(".nm-count").textContent = list.length
      ? Object.entries(counts).map(([t, c]) => `${c} × ${nodeTypeName(t)}`).join(" · ") || `${list.length} row${list.length > 1 ? "s" : ""}`
      : "";
    root.querySelector(".nm-empty").hidden = list.length > 0;
  }

  // one row's problem, or "" - shown under it
  function rowProblem(row, all) {
    const type = row.querySelector(".nm-type").value;
    const sn = serialOf(row);
    if (!type && !sn) return "";
    if (!type) return "Choose the node type";
    if (!sn) return "Choose the serial";
    if (all.filter((r) => serialOf(r) === sn).length > 1) return "This serial is in two rows";
    if (!available) return "";
    if (!choicesFor(type, row).includes(sn)) {
      const t = typeOfSerial(sn);
      return t && t !== type ? `${sn} is a ${nodeTypeName(t)}` : `${sn} isn't an available ${nodeTypeName(type)} - it's on another farm or doesn't exist`;
    }
    return "";
  }

  function unmark(row) {
    row.querySelector(".nm-msg").textContent = "";
    row.classList.remove("bad");
  }

  function mark(row) {
    const msg = rowProblem(row, rows());
    row.querySelector(".nm-msg").textContent = msg;
    row.classList.toggle("bad", !!msg);
  }

  rowsBox.addEventListener("change", (e) => {
    const row = e.target.closest(".nm-row");
    if (!row) return;
    if (e.target.matches(".nm-type")) {
      const sn = serialOf(row);
      if (sn && !choicesFor(e.target.value, row).includes(sn)) row.querySelector(".nm-serial").value = "";
    }
    if (e.target.matches(".nm-serial")) {
      const input = e.target, sn = cleanSerial(input.value);
      input.value = sn;
      const sel = row.querySelector(".nm-type");
      if (sn && !sel.value) {
        const t = typeOfSerial(sn);
        if (t) sel.value = t;           // scanned with no type chosen: its type
      }
    }
    refresh();
    // marks on the rows with a serial in (a row just given its type isn't wrong yet - read() marks everything)
    rows().forEach((r) => (serialOf(r) ? mark(r) : unmark(r)));
  });
  rowsBox.addEventListener("keydown", (e) => {
    // a scanner ends with Enter - don't submit the form; go to a new row's type
    if (e.key === "Enter" && e.target.matches(".nm-serial")) {
      e.preventDefault();
      e.target.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  rowsBox.addEventListener("click", (e) => {
    const del = e.target.closest(".nm-del");
    if (!del) return;
    del.closest(".nm-row").remove();
    refresh();
    rows().forEach((r) => (serialOf(r) ? mark(r) : unmark(r)));
  });
  root.querySelector(".nm-add").addEventListener("click", () => {
    const row = addRow();
    row.querySelector(".nm-type").focus();
    load();
  });
  // The list loads on the first Add node / fill() - by then the admin is
  // signed in (a query before sign-in is refused).
  refresh();

  return {
    /** A saved farm's nodes (Edit) - shown, and theirs to keep. */
    fill(nodes) {
      own = (Array.isArray(nodes) ? nodes : []).filter((n) => n && n.serialNumber).map((n) => ({ type: n.type, serialNumber: cleanSerial(n.serialNumber) }));
      previous = own.map((n) => ({ ...n }));
      rowsBox.innerHTML = "";
      own.forEach((n) => addRow(n.type, n.serialNumber));
      refresh();
      load();
    },
    /** { nodes: [{ type, serialNumber }], error } - empty rows are skipped. */
    read() {
      const all = rows();
      all.forEach(mark);
      const bad = all.find((r) => rowProblem(r, all));
      const nodes = all.map((r) => ({ type: r.querySelector(".nm-type").value, serialNumber: serialOf(r) })).filter((n) => n.type || n.serialNumber);
      return { nodes, error: bad ? `Node Mapping, row ${all.indexOf(bad) + 1}: ${rowProblem(bad, all)}` : null };
    },
    /** Before saving: still free right now? -> an error message or null. */
    async check(farmerDocId = null) {
      // a hub-only farm (no node rows): nothing to check, nothing read
      if (!this.read().nodes.length) return null;
      await load();
      const { nodes, error } = this.read();
      if (error) return error;
      try {
        await Promise.all(nodes.map(async (n) => {
          const why = await problemNow(db, n, farmerDocId);
          if (why) throw new Error(why);
        }));
      } catch (err) {
        return `Node Mapping: ${err.message}`;
      }
      return null;
    },
    /** After the farm is saved: claims the new nodes, frees the removed ones, stores the list on the farm. */
    async save({ farmerDocId, farmBuddieId }) {
      const { nodes, error } = this.read();
      if (error) throw new Error(error);
      if (!nodes.length && !previous.length) return nodes;     // hub only, and nothing to free: no write
      await saveNodeMapping(db, { farmerDocId, farmBuddieId, nodes, previous });
      previous = nodes.map((n) => ({ ...n }));
      own = previous.map((n) => ({ ...n }));
      return nodes;
    },
    get changed() {
      const key = (l) => l.map((n) => `${n.type}:${n.serialNumber}`).sort().join();
      return key(this.read().nodes) !== key(previous);
    }
  };
}

async function problemNow(db, n, farmerDocId) {
  const snap = await getDoc(doc(db, "nodes", n.serialNumber));
  return whyNot(snap, n, farmerDocId);
}

function whyNot(snap, n, farmerDocId) {
  if (!snap.exists()) return `${n.serialNumber} isn't a node made in Production`;
  const d = snap.data();
  if (d.type !== n.type) return `${n.serialNumber} is a ${nodeTypeName(d.type)}, not a ${nodeTypeName(n.type)}`;
  if (d.status === "assigned" && (!farmerDocId || d.farmerDocId !== farmerDocId)) return `${n.serialNumber} is already on farm ${d.farmerId || d.farmerDocId}`;
  if (d.status !== "available" && d.status !== "assigned") return `${n.serialNumber} is not available (${d.status})`;
  return "";
}

/**
 * One transaction: every node of `nodes` still free (or already this farm's)
 * -> assigned to this farm; every node of `previous` no longer listed ->
 * available again; the farm's list -> farmers/<id>.nodes. All or nothing.
 */
export async function saveNodeMapping(db, { farmerDocId, farmBuddieId, nodes, previous = [] }) {
  const keep = new Set(nodes.map((n) => n.serialNumber));
  const removed = previous.filter((n) => !keep.has(n.serialNumber));
  await runTransaction(db, async (t) => {
    const refs = [...nodes, ...removed].map((n) => doc(db, "nodes", n.serialNumber));
    const snaps = [];
    for (const r of refs) snaps.push(await t.get(r));     // all reads first
    nodes.forEach((n, i) => {
      const why = whyNot(snaps[i], n, farmerDocId);
      if (why) throw new Error(why);
    });
    nodes.forEach((n, i) => {
      const d = snaps[i].data();
      if (d.status === "assigned" && d.farmerDocId === farmerDocId) return;     // already this farm's
      t.update(refs[i], { status: "assigned", farmerDocId, farmerId: farmBuddieId || null, assignedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    });
    removed.forEach((n, k) => {
      const i = nodes.length + k;
      const d = snaps[i].exists() ? snaps[i].data() : null;
      if (!d || d.farmerDocId !== farmerDocId) return;                          // not ours any more - leave it
      t.update(refs[i], { status: "available", farmerDocId: null, farmerId: null, assignedAt: null, updatedAt: serverTimestamp() });
    });
    t.update(doc(db, "farmers", farmerDocId), { nodes: nodes.map((n) => ({ type: n.type, serialNumber: n.serialNumber })), nodesUpdatedAt: serverTimestamp() });
  });
}

/** View pages (and their PDF / print): the farm's nodes as an info grid. */
export function nodeMappingViewHtml(nodes) {
  const list = Array.isArray(nodes) ? nodes.filter((n) => n && n.serialNumber) : [];
  return `
    <div class="section-title">🔗 Node Mapping</div>
    <div class="info-grid">${list.length
      ? list.map((n) => `<div class="info-item"><b>${esc(nodeTypeName(n.type))}:</b> ${esc(n.serialNumber)}</div>`).join("")
      : `<div class="info-item full">No nodes - hub only</div>`}</div>`;
}

/** Excel: one column with every node ("Motor node FBMN2610001, ..."), "None" for a hub-only farm. */
export function nodeMappingExportText(nodes) {
  const list = Array.isArray(nodes) ? nodes.filter((n) => n && n.serialNumber) : [];
  return list.length ? list.map((n) => `${nodeTypeName(n.type)} ${n.serialNumber}`).join(", ") : "None";
}
