




(function() {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const ICONS = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️'
  };

  window.showToast = function(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${ICONS[type] || 'ℹ️'}</span>
      <span>${message}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  };

  
  if (!document.getElementById('toastStyles')) {
    const style = document.createElement('style');
    style.id = 'toastStyles';
    style.textContent = `
      .toast-container {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 9999;
        display: flex;
        flex-direction: column;
        gap: 10px;
        pointer-events: none;
      }
      .toast {
        background: white;
        border-left: 4px solid #ffb997;
        border-radius: 10px;
        padding: 14px 20px;
        min-width: 240px;
        max-width: 380px;
        box-shadow: 0 8px 30px rgba(26,26,26,0.15);
        font-size: 14px;
        font-weight: 500;
        color: #1a1a1a;
        pointer-events: auto;
        animation: toastSlideIn 0.3s ease;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .toast.success { border-left-color: #43a047; color: #2e7d32; }
      .toast.error { border-left-color: #e53935; color: #c62828; }
      .toast.info { border-left-color: #1e88e5; color: #1565c0; }
      .toast.warning { border-left-color: #fb8c00; color: #e65100; }
      .toast.removing { animation: toastSlideOut 0.3s ease forwards; }
      @keyframes toastSlideIn {
        from { transform: translateX(400px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes toastSlideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(400px); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }
})();