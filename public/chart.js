const updateIntervals = {
    '1h': 400,    // Every block
    '6h': 5000,   // 5 seconds
    '12h': 10000, // 10 seconds
    '24h': 60000, // 1 minute
    '72h': null,  // Manual refresh
    '7d': null    // Manual refresh
};

let chart;
let updateInterval;
let currentRange = '1h';
let isPaused = false;

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
                label: 'Actual Gas Price',
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
                            minute: 'HH:mm'
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

function updateChartData() {
    if (isPaused) return;
    fetchData();
}

function setUpdateInterval(range) {
    if (updateInterval) {
        clearInterval(updateInterval);
    }

    const interval = updateIntervals[range];
    if (interval) {
        updateInterval = setInterval(updateChartData, interval);
    }
}

async function fetchData() {
    try {
        const response = await fetch(`/api/chart-data?range=${currentRange}`);
        const { seiData, evmData } = await response.json();

        chart.data.labels = seiData.map(d => new Date(d.timestamp));
        chart.data.datasets[0].data = seiData.map(d => d.confidence99);
        chart.data.datasets[1].data = evmData.map(d => d.confidence99);

        chart.update('none');
        updateMetrics(seiData, evmData);
    } catch (error) {
        console.error('Error fetching chart data:', error);
    }
}

function setupTimeRangeButtons() {
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
}
