const loginForm = document.querySelector('#login-form');
loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#login-btn');
  const errorLabel = document.querySelector('#login-error');
  button.disabled = true;
  errorLabel.textContent = '';
  try {
    const response = await fetch('/api/auth/login', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: document.querySelector('#login-user').value,
        password: document.querySelector('#login-pass').value})});
    if (!response.ok) throw new Error('帳號或密碼錯誤');
    const data = await response.json();
    localStorage.setItem('ticket_token', data.access_token);
    location.replace('/');
  } catch (error) { errorLabel.textContent = error.message; }
  finally { button.disabled = false; }
});
