/**
 * LEAFEE WIDGET - Logic
 * Uses window.openai Apps SDK globals
 */

const root = document.getElementById("app");

/**
 * RENDERER
 * Creates the HTML structure based on tool output and widget state
 */
function render() {
  const output = window.openai?.toolOutput;
  const state = window.openai?.widgetState || {};

  // 1. Loading State
  if (!output) {
    root.innerHTML = `
      <div class="loading-container">
        <div class="spinner"></div>
        <div>Analyse en cours...</div>
      </div>
    `;
    return;
  }

  const { plantName, severity, shortSummary, issues, confidence, careTips } = output;
  const isExpanded = state.isExpanded ?? false;

  // 2. Main Template
  root.innerHTML = `
    <div class="card">
      <div class="header">
        <div class="title-group">
          <div class="plant-name">${plantName || 'Plante'}</div>
          <div class="confidence">Indice de confiance: ${Math.round((confidence || 0) * 100)}%</div>
        </div>
        <div class="badge severity-${severity || 'medium'}">
          ${getSeverityLabel(severity)}
        </div>
      </div>
      
      <p class="summary">${shortSummary}</p>
      
      ${issues?.length > 0 ? `
        <div class="issues-container">
          ${issues.map(i => `<span class="issue-tag">${i.label}</span>`).join('')}
        </div>
      ` : ''}

      <div class="tips-section" id="tips-section">
        <div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="toggleTips()">
          <span class="tips-title">Conseils d'entretien</span>
          <span style="font-size: 12px;">${isExpanded ? '▲' : '▼'}</span>
        </div>
        
        ${isExpanded ? `
          <ul class="tips-list">
            ${(careTips || []).map(tip => `<li>${tip}</li>`).join('')}
          </ul>
        ` : ''}
      </div>
    </div>
  `;
}

/**
 * HELPERS
 */
function getSeverityLabel(severity) {
  const labels = {
    low: 'Saine',
    medium: 'À surveiller',
    high: 'Urgence'
  };
  return labels[severity] || labels.medium;
}

/**
 * INTERACTIONS
 * Uses window.openai.setWidgetState to persist UI state
 */
window.toggleTips = function() {
  const currentState = window.openai?.widgetState || {};
  const nextExpanded = !(currentState.isExpanded ?? false);
  
  // Persist state to the host (ChatGPT)
  window.openai?.setWidgetState({
    ...currentState,
    isExpanded: nextExpanded
  });
  
  // Re-render will be triggered by onStateChange if available, 
  // or manually here for immediate feedback
  render();
};

/**
 * LIFECYCLE
 */
// Initial render
render();

// Subscribe to state changes (theme, widgetState, etc.)
if (window.openai?.onStateChange) {
  window.openai.onStateChange(() => {
    console.log("[Widget] State changed, re-rendering...");
    render();
  });
}

// Ensure the host knows about content height changes
const resizeObserver = new ResizeObserver(() => {
  window.openai?.notifyIntrinsicHeight?.(document.body.scrollHeight);
});
resizeObserver.observe(document.body);
