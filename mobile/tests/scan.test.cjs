const assert = require("node:assert/strict");
const {
  uniqueCodes, is711Pair, is711Batch, is711Title,
  previewText, mergeTickets, parsePairQR,
} = require("../src/core");

const mdn = ["MDN5955857100094", "MDN5988938866230", "MDN5959064503853"];
assert.deepEqual(uniqueCodes([...mdn, mdn[1], mdn[0]]), mdn);
assert.equal(previewText("【麥當勞】漢堡(好禮即享券)", mdn),
  "【麥當勞】漢堡(好禮即享券)\n" + mdn.join("\n"));

assert.equal(is711Pair("7100016003609284", "3CXR4ME8"), true);
assert.equal(is711Pair("3CXR4ME8", "7100016003609284"), true);
assert.equal(is711Batch(["7100016003609284", "3CXR4ME8"]), true);
assert.equal(is711Batch(["7100016003609284"]), false);
assert.equal(is711Batch(["1234567890123456", "abcdefgh"]), false);
assert.equal(is711Title("7-11商品卡#711"), true);

const local = [{ id: 1, name: "保留", local_state: 2 }, { id: 2, name: "已刪", local_state: 0 }];
const remote = [{ id: 1, name: "更新", local_state: 1 }, { id: 3, name: "新增", local_state: 0 }];
assert.deepEqual(mergeTickets(local, remote, "mirror"), remote);
assert.deepEqual(mergeTickets(local, remote, "append"),
  [...local, { id: 3, name: "新增", local_state: 0 }]);
assert.throws(() => mergeTickets(local, null, "mirror"));

const token = "mob_" + "T".repeat(64);
assert.deepEqual(parsePairQR(JSON.stringify({
  type: "tick_server_pair_v1", server: "https://example.com", token,
})), { server: "https://example.com", token });
assert.throws(() => parsePairQR(JSON.stringify({
  type: "tick_server_pair_v1", server: "http://example.com", token,
})), /HTTPS/);
assert.throws(() => parsePairQR("https://example.com/share#token=abc"));
console.log("mobile scan and sync tests passed");
