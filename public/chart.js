// Global error monitoring
window.addEventListener('error', (event) => {
  console.error('Script error:', event.error);
});

// Chart initialization and state management
let chart;
let updateInterval;
let currentRange = '1h';
let isPaused = false;
let lastDataTimestamp = null;

const updateIntervals = {
  '1h': 1000,    // 1s
  '6h': 5000,
  '12h': 10000,
  '24h': 30000,
  '72h': 60000,
  '7d': 300000
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
            font: { size: 12 }
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
              minute: 'HH:mm:ss',
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
    
    const { predictedData, seiGasPriceData, bufferStats } = await response.json();

    // Update chart data
    chart.data.datasets[0].data = predictedData.map(d => ({
      x: new Date(d.timestamp),
      y: d.confidence99 || null
    }));
    
    chart.data.datasets[1].data = seiGasPriceData.map(d => ({
      x: new Date(d.timestamp),
      y: d.confidence99 || null
    }));
    
    // For 1h view, only update if we have new data
    if (currentRange === '1h' && lastDataTimestamp) {
      const latestTimestamp = Math.max(
        ...predictedData.map(d => new Date(d.timestamp).getTime()),
        ...seiGasPriceData.map(d => new Date(d.timestamp).getTime())
      );
      
      if (latestTimestamp <= lastDataTimestamp) {
        return;
      }
    }
    
    // Store latest timestamp
    lastDataTimestamp = Math.max(
      ...predictedData.map(d => new Date(d.timestamp).getTime()),
      ...seiGasPriceData.map(d => new Date(d.timestamp).getTime())
    );

    // Update chart scales based on timeframe
    updateChartScales(currentRange);
    
    // Use requestAnimationFrame for smoother updates
    requestAnimationFrame(() => {
      chart.update('none'); // Update without animation for better performance
    });

    // Update buffer stats if available
    if (bufferStats) {
      updateBufferStats(bufferStats);
    }
  } catch (error) {
    console.error('Error fetching chart data:', error);
    showError(error.message);
  }
}

function updateBufferStats(stats) {
  if (!stats) return;
  
  const statsContainer = document.getElementById('bufferStats');
  if (statsContainer) {
    statsContainer.innerHTML = `
      <div class="buffer-stat">
        <span>Buffer Size:</span>
        <span>${stats.bufferSize}</span>
      </div>
      <div class="buffer-stat">
        <span>Write Buffer:</span>
        <span>${stats.writeBufferSize}</span>
      </div>
      <div class="buffer-stat">
        <span>Block Range:</span>
        <span>${stats.oldestBlock} - ${stats.newestBlock}</span>
      </div>
    `;
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

  const ticksLimit = {
    '1h': 12,
    '6h': 6,
    '12h': 12,
    '24h': 8,
    '72h': 9,
    '7d': 7
  }[range] || 8;

  chart.options.scales.x.time.unit = timeUnit;
  chart.options.scales.x.ticks.maxTicksLimit = ticksLimit;

  // Adjust time display format based on range
  if (range === '1h') {
    chart.options.scales.x.time.displayFormats.minute = 'HH:mm:ss';
  } else {
    chart.options.scales.x.time.displayFormats.minute = 'HH:mm';
  }
}

function showError(message) {
  const errorBanner = document.getElementById('errorBanner') || createErrorBanner();
  errorBanner.textContent = `Error: ${message}`;
  errorBanner.style.opacity = '1';
  
  setTimeout(() => {
    errorBanner.style.opacity = '0';
  }, 5000);
}

function createErrorBanner() {
  const banner = document.createElement('div');
  banner.id = 'errorBanner';
  banner.className = 'error-banner';
  document.body.appendChild(banner);
  return banner;
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
      lastDataTimestamp = null; // Reset timestamp on range change
      setUpdateInterval(range);
      fetchData();
    });
    
    container.appendChild(button);
  });

  const pauseButton = document.getElementById('pauseUpdates');
  pauseButton.addEventListener('click', function() {
    isPaused = !isPaused;
    this.textContent = isPaused ? 'Resume Updates' : 'Pause Updates';
    this.classList.toggle('active', isPaused);
    if (!isPaused) {
      lastDataTimestamp = null; // Reset timestamp when resuming
      fetchData();
    }
  });
}

// Initialize everything when the page loads
window.addEventListener('load', () => {
  try {
    initChart();
    setupEventListeners();
    setUpdateInterval('1h');
    fetchData();
  } catch (error) {
    console.error('Initialization error:', error);
    showError('Failed to initialize application');
  }
});

// Cleanup on page unload
window.addEventListener('unload', () => {
  if (updateInterval) {
    clearInterval(updateInterval);
  }
});