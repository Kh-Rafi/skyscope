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
      <span class="toast-text">${message}</span>
      <button class="toast-close" type="button" aria-label="Close">✕</button>
    `;

    container.appendChild(toast);

    // Progress bar that shrinks over `duration` ms
    const progress = document.createElement('div');
    progress.className = 'toast-progress';
    progress.style.animationDuration = `${duration}ms`;
    toast.appendChild(progress);

    let timer = null;

    const dismiss = () => {
      if (timer) clearTimeout(timer);
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    };

    // Manual dismiss
    toast.querySelector('.toast-close').addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
    });

    // Auto dismiss
    timer = setTimeout(dismiss, duration);
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
        position: relative;
        background: white;
        border-left: 4px solid #ffb997;
        border-radius: 10px;
        padding: 14px 40px 14px 20px;
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
        overflow: hidden;
      }
      .toast-text {
        flex: 1;
        line-height: 1.4;
      }
      .toast-close {
        position: absolute;
        top: 6px;
        right: 6px;
        background: transparent;
        border: none;
        font-size: 12px;
        color: inherit;
        opacity: 0.45;
        cursor: pointer;
        padding: 4px 6px;
        border-radius: 6px;
        transition: opacity 0.15s, background 0.15s;
        line-height: 1;
      }
      .toast-close:hover {
        opacity: 1;
        background: rgba(0, 0, 0, 0.06);
      }
      .toast-progress {
        position: absolute;
        left: 0;
        bottom: 0;
        height: 2px;
        width: 100%;
        background: currentColor;
        opacity: 0.35;
        transform-origin: left center;
        animation: toastProgress linear forwards;
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
      @keyframes toastProgress {
        from { transform: scaleX(1); }
        to { transform: scaleX(0); }
      }
    `;
    document.head.appendChild(style);
  }
})();
