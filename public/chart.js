let chart;
let updateInterval;
let currentRange = '1h';
let isPaused = false;

const updateIntervals = {
  '1h': 400,
  '6h': 5000,
  '12h': 10000,
  '24h': 60000,
  '72h': null,
  '7d': null
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
      animation: { duration: 300 },
      interaction: {
        intersect: false,
        mode: 'nearest'
      },
      plugins: {
        legend: {
          labels: { color: '#d4d4d4' }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
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
            }
          },
          grid: {
            color: 'rgba(255, 255, 255, 0.1)'
          },
          ticks: { 
            color: '#d4d4d4',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8
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
  document.getElementById('missedBlocks').textContent = metrics.missedBlocks;
  document.getElementById('nullValues').textContent = metrics.nullValues;
  document.getElementById('apiErrors').textContent = metrics.apiErrors;
  document.getElementById('lastProcessedBlock').textContent = metrics.lastProcessedBlock;
  document.getElementById('lastSync').textContent = new Date(metrics.lastSync).toLocaleTimeString();
}

async function fetchData() {
  if (isPaused) return;
  try {
    const response = await fetch(`/api/chart-data?range=${currentRange}`);
    const { predictedData, seiGasPriceData, metrics } = await response.json();

    chart.data.labels = predictedData.map(d => new Date(d.timestamp));
    chart.data.datasets[0].data = predictedData.map(d => d.confidence99);
    chart.data.datasets[1].data = seiGasPriceData.map(d => d.confidence99);
    
    chart.update('none');
    updateMetricsDisplay(metrics);
  } catch (error) {
    console.error('Error fetching chart data:', error);
  }
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
    button.addEventListener('click', () => {
      document.querySelectorAll('.controls button').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
      currentRange = range;
      setUpdateInterval(range);
      fetchData();
    });
    container.appendChild(button);
  });

  document.getElementById('togglePredicted').addEventListener('click', function() {
    const dataset = chart.data.datasets[0];
    dataset.hidden = !dataset.hidden;
    this.classList.toggle('active', !dataset.hidden);
  });

  document.getElementById('toggleActual').addEventListener('click', function() {
    const dataset = chart.data.datasets[1];
    dataset.hidden = !dataset.hidden;
    this.classList.toggle('active', !dataset.hidden);
  });

  document.getElementById('pauseUpdates').addEventListener('click', function() {
    isPaused = !isPaused;
    this.textContent = isPaused ? 'Resume Updates' : 'Pause Updates';
    this.classList.toggle('active', isPaused);
  });
}
