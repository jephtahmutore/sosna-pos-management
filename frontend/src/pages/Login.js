import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  isHqHost, getHqBranch, setHqBranch, getHqBranches,
} from '../services/api';

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  // HQ-only: branch picker. On a per-branch subdomain we hide this
  // entirely — the host already pins the tenant.
  const hq = isHqHost();
  const [branches, setBranches] = useState([]);
  const [branch, setBranch] = useState(() => getHqBranch());
  const [loadingBranches, setLoadingBranches] = useState(false);

  useEffect(() => {
    if (!hq) return;
    setLoadingBranches(true);
    getHqBranches()
      .then(res => setBranches(res.data?.branches || []))
      .catch(() => setBranches([]))
      .finally(() => setLoadingBranches(false));
  }, [hq]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (hq && !branch) {
      setError('Please choose a branch to sign in to.');
      return;
    }
    setLoading(true);
    try {
      // Persist branch BEFORE the login call so the axios interceptor
      // already attaches X-Branch to /auth/login.
      if (hq) setHqBranch(branch);
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <div className="login-logo">🍾</div>
          <h1>Sosna{hq ? ' HQ' : ''}</h1>
          <p>{hq ? 'Head Office — pick a branch to manage' : 'Distribution Management'}</p>
        </div>
        {error && <div className="login-error">{error}</div>}
        <form className="login-form" onSubmit={handleSubmit}>
          {hq && (
            <div className="form-group">
              <label>Branch</label>
              <select value={branch} onChange={e => setBranch(e.target.value)} required
                style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', background: '#fff' }}>
                <option value="" disabled>
                  {loadingBranches ? 'Loading branches…' : 'Select a branch'}
                </option>
                {branches.map(b => (
                  <option key={b.slug} value={b.slug}>{b.name} ({b.slug})</option>
                ))}
              </select>
            </div>
          )}
          <div className="form-group">
            <label>Username</label>
            <input type="text" value={email} onChange={e => setEmail(e.target.value)} placeholder="Enter your username" required />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" required />
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Signing in...' : hq ? `Sign In to ${branch || 'Branch'}` : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;
