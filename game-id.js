// Игровые ID: прежние числовые и пользовательские из латинских букв/цифр.
const valid = id => /^(?:\d{5,12}|(?=[A-Za-z0-9]{3,20}$)(?=.*[A-Za-z])[A-Za-z0-9]+)$/.test(String(id || ''));
const same = (a,b) => !!a && !!b && String(a).toUpperCase() === String(b).toUpperCase();
module.exports = {valid, same};
