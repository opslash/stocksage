// ==========================================
// Authentication & Profile
// ==========================================
let isRegisterMode = false;

function openAuthModal() {
  document.getElementById("authModal").style.display = "flex";
  document.getElementById("authError").style.display = "none";
  document.getElementById("authUsername").value = "";
  document.getElementById("authPassword").value = "";
}

function closeAuthModal() {
  document.getElementById("authModal").style.display = "none";
}

function toggleAuthMode() {
  isRegisterMode = !isRegisterMode;
  document.getElementById("authTitle").innerText = isRegisterMode
    ? "Register"
    : "Sign In";
  document.getElementById("authSubmitBtn").innerText = isRegisterMode
    ? "Register"
    : "Login";
  document.getElementById("authToggleText").innerHTML = isRegisterMode
    ? 'Already have an account? <a href="#" onclick="toggleAuthMode(); return false;">Sign In</a>'
    : 'Don\'t have an account? <a href="#" onclick="toggleAuthMode(); return false;">Register</a>';
}

async function submitAuth(e) {
  e.preventDefault();
  const username = document.getElementById("authUsername").value;
  const password = document.getElementById("authPassword").value;
  const endpoint = isRegisterMode ? "/api/auth/register" : "/api/auth/login";

  const submitBtn = document.getElementById("authSubmitBtn");
  const originalBtnText = submitBtn.innerText;
  submitBtn.innerText = "Loading...";
  submitBtn.disabled = true;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById("authError").innerText =
        data.detail || "Authentication failed";
      document.getElementById("authError").style.display = "block";
      submitBtn.innerText = originalBtnText;
      submitBtn.disabled = false;
      return;
    }
    localStorage.setItem("jwt_token", data.access_token);
    localStorage.setItem("username", data.username);
    closeAuthModal();
    updateAuthUI();
    // Fetch user's watchlist upon successful login
    await fetchWatchlist();
    // Reload data that requires auth
    if (window.location.hash === "#watchlist") renderWatchlistDashboard();
    // Update star icon if on a stock page
    if (AppState.currentTicker) renderHero(AppState.stockData);
  } catch (err) {
    document.getElementById("authError").innerText =
      "Network error during authentication";
    document.getElementById("authError").style.display = "block";
  } finally {
    submitBtn.innerText = originalBtnText;
    submitBtn.disabled = false;
  }
}

function updateAuthUI() {
  const token = localStorage.getItem("jwt_token");
  const username = localStorage.getItem("username");
  if (token && username) {
    document.getElementById("btnOpenAuth").style.display = "none";
    document.getElementById("userProfile").style.display = "block";
    document.getElementById("profileName").innerText = username;
    const profileNameDisplay = document.getElementById("profileNameDisplay");
    if (profileNameDisplay) profileNameDisplay.innerText = username;
  } else {
    document.getElementById("btnOpenAuth").style.display = "block";
    document.getElementById("userProfile").style.display = "none";
  }
  
  if (window.loadSavedScreens) {
    loadSavedScreens();
  }
}

function toggleProfileMenu() {
  const menu = document.getElementById("profileMenu");
  menu.style.display = menu.style.display === "none" ? "block" : "none";
}

function logoutUser() {
  localStorage.removeItem("jwt_token");
  localStorage.removeItem("username");
  updateAuthUI();
  document.getElementById("profileMenu").style.display = "none";
  AppState.watchlist = []; // Clear local watchlist state
  if (window.location.hash === "#watchlist") renderWatchlistDashboard();
  if (AppState.currentTicker) renderHero(AppState.stockData);
}

// Close profile menu and modal if clicked outside
document.addEventListener("click", function(event) {
  // Handle profile menu closing
  const profileMenu = document.getElementById("profileMenu");
  const btnProfile = document.getElementById("btnProfile");
  if (profileMenu && btnProfile && profileMenu.style.display === "block") {
    if (!profileMenu.contains(event.target) && !btnProfile.contains(event.target)) {
      profileMenu.style.display = "none";
    }
  }

  // Handle modal closing
  const authModal = document.getElementById("authModal");
  if (authModal && authModal.style.display === "flex") {
    if (event.target === authModal) {
      closeAuthModal();
    }
  }
});

// Call on startup
document.addEventListener("DOMContentLoaded", updateAuthUI);

