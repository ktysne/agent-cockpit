// プロダクトの検査と表示用の複製を担い、入力を変更しない。
const { isRecord } = require('./value-utils');

function validProduct(value) {
  return isRecord(value) && typeof value.key === 'string' && value.key.trim().length > 0 && value.key.length <= 500 &&
    typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 200;
}

function cloneProduct(product) {
  return validProduct(product) ? { key: product.key, name: product.name } : null;
}

function repoProduct(owner, repo) {
  return { key: `repo:${owner}/${repo}`, name: `${owner}/${repo}` };
}

module.exports = {
  validProduct,
  cloneProduct,
  repoProduct,
};
