import test from "node:test";
import assert from "node:assert/strict";
import { valveListsFromSnapshot, renderValvesInto } from "../../public/js/device-status-render.js";

// Admin > Device View's valve grid (public/js/device-view.js).

// The bits of a DOM the renderer touches.
function fakeGrid() {
  const grid = {
    children: [],
    set innerHTML(html) { this.children = html ? [{ innerHTML: html }] : []; },
    appendChild(el) { this.children.push(el); },
  };
  return grid;
}
globalThis.document = { createElement: () => ({ className: "", innerHTML: "" }) };
const text = (el) => el.innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// One 6-valve unit (valves 1-6). V1 was open when the power went.
const snapshot = (unitOn) => ({
  max: 64,
  open: "0000000000000001",
  online: unitOn ? "000000000000003f" : "0000000000000000",
  units: [{ u: "NODE_1", o: 0, n: 6, on: unitOn }],
});

test("all 6 valves of a unit that went offline (power cut) are still shown", () => {
  const lists = valveListsFromSnapshot(snapshot(false));
  const grid = fakeGrid();
  renderValvesInto(grid, lists.valves, true, lists.valvesOnline, lists.valvesPaired);
  assert.equal(grid.children.length, 6);
  assert.equal(text(grid.children[0]), "V1 OFFLINE last: open");
  assert.equal(text(grid.children[5]), "V6 OFFLINE");
});

test("unit online: open and closed", () => {
  const lists = valveListsFromSnapshot(snapshot(true));
  const grid = fakeGrid();
  renderValvesInto(grid, lists.valves, true, lists.valvesOnline, lists.valvesPaired);
  assert.equal(grid.children.length, 6);
  assert.equal(text(grid.children[0]), "V1 OPEN");
  assert.equal(text(grid.children[1]), "V2 CLOSED");
});

test("hub offline: every paired valve, state unknown", () => {
  const lists = valveListsFromSnapshot(snapshot(false));
  const grid = fakeGrid();
  renderValvesInto(grid, lists.valves, false, lists.valvesOnline, lists.valvesPaired);
  assert.equal(grid.children.length, 6);
  assert.equal(text(grid.children[3]), "V4 --");
});

test("older firmware without the unit list: reporting or open valves, as before", () => {
  const { units, ...old } = snapshot(false);
  const lists = valveListsFromSnapshot(old);
  assert.equal(lists.valvesPaired, null);
  const grid = fakeGrid();
  renderValvesInto(grid, lists.valves, true, lists.valvesOnline, lists.valvesPaired);
  assert.equal(grid.children.length, 1);
});

test("no valves at all", () => {
  const grid = fakeGrid();
  renderValvesInto(grid, [], true, [], []);
  assert.match(grid.children[0].innerHTML, /No valves paired/);
});
