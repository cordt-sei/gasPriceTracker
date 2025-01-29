let chart;
let updateInterval;
let currentRange = '1h';
let isPaused = false;

const updateIntervals = {
  '1h': 400,    // Update every 400ms for 1h view
  '6h': 5000,   // Every 5s for 6h view
  '12h': 10000, // Every 10s for 12h view
  '24h': 30000, // Every 30s for 24h view
  '72h': 60000, // Every minute for 72h view
  '7d': 300000  // Every 5 minutes for 7d view
};

function initChart() {
  const ctx = document.getElementById('gasPriceChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Predicted Gas Price',
        data: [],
        borderColor: '#4caf50',
        backgroundColor: 'rgba(76, 175, 80, 0.1)',
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        tension: 0.4
      }, {
        label: 'Sei Gas Price',
        data: [],
        borderColor: '#e91e63',
        backgroundColor: 'rgba(233, 30, 99, 0.1)',
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { 
        duration: 300,
        easing: 'easeInOutQuad'
      },
      interaction: {
        intersect: false,
        mode: 'nearest',
        axis: 'x'
      },
      plugins: {
        legend: {
          position: 'top',
          labels: { 
            color: '#d4d4d4',
            font: {
              size: 12
            }
          }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: 'rgba(45, 45, 45, 0.9)',
          titleColor: '#fff',
          bodyColor: '#fff',
          borderColor: 'rgba(255, 255, 255, 0.2)',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: (context) => {
              const value = context.raw || 0;
              return `${context.dataset.label}: ${value.toFixed(2)} Gwei`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: {
            unit: 'minute',
            displayFormats: {
              minute: 'HH:mm',
              hour: 'HH:mm',
              day: 'MMM D'
            },
            tooltipFormat: 'MMM D, HH:mm:ss'
          },
          grid: {
            color: 'rgba(255, 255, 255, 0.1)'
          },
          ticks: { 
            color: '#d4d4d4',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8
          },
          adapters: {
            date: {
              locale: 'en'
            }
          }
        },
        y: {
          beginAtZero: true,
          grid: {
            color: 'rgba(255, 255, 255, 0.1)'
          },
          ticks: {
            color: '#d4d4d4',
            callback: value => `${value.toFixed(1)} Gwei`
          }
        }
      }
    }
  });
}

function updateMetricsDisplay(metrics) {
  document.getElementById('missedBlocks').textContent = metrics.missedBlocks.toLocaleString();
  document.getElementById('nullValues').textContent = metrics.nullValues.toLocaleString();
  document.getElementById('apiErrors').textContent = metrics.apiErrors.toLocaleString();
  document.getElementById('lastProcessedBlock').textContent = metrics.lastProcessedBlock.toLocaleString();
  
  const lastSync = metrics.lastSync ? new Date(metrics.lastSync) : null;
  document.getElementById('lastSync').textContent = lastSync ? lastSync.toLocaleTimeString() : '-';
}

async function fetchData() {
  if (isPaused) return;
  
  try {
    const response = await fetch(`/api/chart-data?range=${currentRange}`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const { predictedData, seiGasPriceData, metrics } = await response.json();

    // Update chart data
    chart.data.labels = predictedData.map(d => new Date(d.timestamp));
    chart.data.datasets[0].data = predictedData.map(d => ({
      x: new Date(d.timestamp),
      y: d.confidence99 || null
    }));
    chart.data.datasets[1].data = seiGasPriceData.map(d => ({
      x: new Date(d.timestamp),
      y: d.confidence99 || null
    }));
    
    // Update chart scales based on timeframe
    updateChartScales(currentRange);
    
    chart.update('none');
    updateMetricsDisplay(metrics);
  } catch (error) {
    console.error('Error fetching chart data:', error);
    // Optionally show error to user
    updateErrorDisplay(error);
  }
}

function updateChartScales(range) {
  const timeUnit = {
    '1h': 'minute',
    '6h': 'hour',
    '12h': 'hour',
    '24h': 'hour',
    '72h': 'day',
    '7d': 'day'
  }[range] || 'hour';

  const tickCount = {
    '1h': 6,
    '6h': 6,
    '12h': 12,
    '24h': 8,
    '72h': 9,
    '7d': 7
  }[range] || 8;

  chart.options.scales.x.time.unit = timeUnit;
  chart.options.scales.x.ticks.maxTicksLimit = tickCount;
}

function setUpdateInterval(range) {
  if (updateInterval) {
    clearInterval(updateInterval);
  }
  
  const interval = updateIntervals[range];
  if (interval) {
    updateInterval = setInterval(fetchData, interval);
  }
}

function updateErrorDisplay(error) {
  const errorBanner = document.getElementById('errorBanner') || createErrorBanner();
  errorBanner.textContent = `Error: ${error.message}`;
  errorBanner.style.opacity = '1';
  
  // Hide after 5 seconds
  setTimeout(() => {
    errorBanner.style.opacity = '0';
  }, 5000);
}

function createErrorBanner() {
  const banner = document.createElement('div');
  banner.id = 'errorBanner';
  banner.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background-color: #f44336;
    color: white;
    padding: 15px;
    border-radius: 4px;
    transition: opacity 0.3s;
    opacity: 0;
    z-index: 1000;
  `;
  document.body.appendChild(banner);
  return banner;
}

function setupEventListeners() {
  const ranges = ['1h', '6h', '12h', '24h', '72h', '7d'];
  const container = document.querySelector('.controls');
  
  ranges.forEach(range => {
    const button = document.createElement('button');
    button.id = range;
    button.textContent = range;
    button.classList.toggle('active', range === currentRange);
    
    button.addEventListener('click', () => {
      document.querySelectorAll('.controls button').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
      currentRange = range;
      setUpdateInterval(range);
      fetchData();
    });
    
    container.appendChild(button);
  });

  document.getElementById('pauseUpdates').addEventListener('click', function() {
    isPaused = !isPaused;
    this.textContent = isPaused ? 'Resume Updates' : 'Pause Updates';
    this.classList.toggle('active', isPaused);
    if (!isPaused) {
      fetchData(); // Immediate update when resuming
    }
  });
}

// Initialize everything when the page loads
window.addEventListener('load', () => {
  initChart();
  setupEventListeners();
  setUpdateInterval('1h');
  fetchData();
});

// Cleanup on page unload
window.addEventListener('unload', () => {
  if (updateInterval) {
    clearInterval(updateInterval);
  }
});
