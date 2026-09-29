



const API = '/api';


const tabLogin = document.getElementById('tabLogin');
const tabRegister = document.getElementById('tabRegister');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');

tabLogin.addEventListener('click', () => {
  tabLogin.classList.add('active');
  tabRegister.classList.remove('active');
  loginForm.classList.remove('hidden');
  registerForm.classList.add('hidden');
  hideMessages();
});

tabRegister.addEventListener('click', () => {
  tabRegister.classList.add('active');
  tabLogin.classList.remove('active');
  registerForm.classList.remove('hidden');
  loginForm.classList.add('hidden');
  hideMessages();
});

function hideMessages() {
  document.getElementById('loginMsg').classList.remove('show');
  document.getElementById('regMsg').classList.remove('show');
}

function showMessage(el, text, type) {
  el.textContent = text;
  el.className = 'auth-message show ' + type;
}


loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('loginMsg');
  const btn = loginForm.querySelector('button');

  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;

  if (!email || !password) {
    return showMessage(msg, 'Please fill all fields', 'error');
  }

  btn.disabled = true;
  btn.textContent = 'Signing in...';

  try {
    const res = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Login failed');

    localStorage.setItem('user', JSON.stringify(data.user));
    showMessage(msg, 'Welcome back! Redirecting...', 'success');

    setTimeout(() => {
      window.location.href = 'app.html';
    }, 700);

  } catch (err) {
    showMessage(msg, err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});


registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('regMsg');
  const btn = registerForm.querySelector('button');

  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;

  if (!name || !email || !password) {
    return showMessage(msg, 'Please fill all fields', 'error');
  }

  if (password.length < 8) {
    return showMessage(msg, 'Password must be at least 8 characters', 'error');
  }

  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const res = await fetch(`${API}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });

    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Registration failed');

    showMessage(msg, 'Account created! Signing you in...', 'success');

    
    const loginRes = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const loginData = await loginRes.json();
    if (loginRes.ok) {
      localStorage.setItem('user', JSON.stringify(loginData.user));
      setTimeout(() => {
        window.location.href = 'app.html';
      }, 700);
    } else {
      tabLogin.click();
    }

  } catch (err) {
    showMessage(msg, err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
});


const existing = localStorage.getItem('user');
if (existing) {
  window.location.href = 'app.html';
}