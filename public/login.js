const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const btn = document.getElementById('login-btn');
const pass = document.getElementById('password');

document.getElementById('toggle-pass').addEventListener('click', () => {
  pass.type = pass.type === 'password' ? 'text' : 'password';
  pass.focus();
});

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.hidden = true;

  const user = document.getElementById('user').value.trim();
  const password = pass.value;
  if (!user || !password) return showError('Escribe usuario y contraseña');

  btn.disabled = true;
  btn.textContent = 'Entrando…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    location.replace('/');
  } catch (err) {
    showError(err.message === 'Failed to fetch'
      ? 'Sin conexión. Revisa tu internet e intenta de nuevo.'
      : err.message);
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
});

document.getElementById('user').focus();
