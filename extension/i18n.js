/**
 * Tab Out — Internationalization (i18n) Engine
 * Ultra-lightweight, zero-dependency, production-grade bilingual engine (English / Tiếng Việt).
 * Compatible with Chrome MV3 storage and runtime lifecycle.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'tabout_language';

  const TRANSLATIONS = {
    en: {
      // Header
      'header.skip_link': 'Skip to content',
      'header.active_tabs': 'Active tabs',
      'header.subtitle': 'Workspace overview across all open windows.',
      'header.open_tabs_count': '{count} open tabs',
      'header.open_tabs_count_suffix': 'open tabs',
      'header.tabs_across_windows': '{tabs} tabs across {windows} {windowWord}',
      
      // Dupe Banner
      'banner.dupe_count': 'You have {count} Tab Out tabs open',
      'banner.close_extras': 'Close extras',
      'banner.dismiss': 'Dismiss notification',

      // Perspectives Rail (Left column)
      'rail.perspectives': 'Perspectives',
      'rail.add_perspective': 'Add new perspective',
      'rail.new_perspective': 'New perspective',
      'rail.recent_tabs': 'Recent',
      'rail.rules_local': 'Local rules',
      'rail.open_source': 'Open source',
      'rail.domain_default': 'Domain',
      'rail.topic_default': 'Topic',
      'rail.purpose_default': 'Purpose',
      'rail.settings': 'Settings',
      'rail.openrouter_config': 'Configure OpenRouter API key',
      'rail.edit_perspective': 'Edit perspective',
      'rail.domain_tooltip': 'Domain: Group tabs by URL hostname — 100% local, no AI',

      // Open Tabs Section (Middle column)
      'tabs.section_title': 'Open tabs',
      'tabs.domains_count': '{count} domains',
      'tabs.domains_local_single': 'domain · Local',
      'tabs.domains_local_plural': 'domains · Local',
      'tabs.categories_of': '{visible} of {total} categories',
      'tabs.categories_single': 'category',
      'tabs.categories_plural': 'categories',
      'tabs.all_closed_title': 'All tabs closed',
      'tabs.all_closed_desc': 'Clean workspace',
      'tabs.quick_return': 'Back to last tab',
      'tabs.close_all': 'Close all',
      'tabs.close_all_count': 'Close all {count} tabs',
      'tabs.close_group': 'Close {count} tabs',
      'tabs.close_group_confirm': 'Close {count} tabs?',
      'tabs.close_dupes': 'Close {count} duplicates',
      'tabs.edit_tags': 'Edit tags',
      'tabs.defer_group': 'Defer',
      'tabs.landing_pages': 'Homepages',
      'tabs.filter_all': 'All',
      'tabs.filter_duplicates': 'Duplicates',
      'tabs.filter_audible': 'Audible',
      'tabs.search_placeholder': 'Search tabs...',
      'tabs.uncategorized': 'Other',
      'chip.recent': 'Recent',
      'chip.recent_title': 'Most recently active tab',
      'chip.save_for_later': 'Save for later',
      'chip.close_tab': 'Close this tab',
      'chip.show_more': '+{count} more',
      'chip.show_more_aria': 'Show {count} more tabs',

      // Saved for Later / Archive (Right column)
      'saved.title': 'Saved for later',
      'saved.empty': 'Nothing saved.',
      'saved.clear_all': 'Clear all',
      'saved.restore_all': 'Restore all',
      'saved.items_count': '{count} {word}',
      'saved.item_dismiss': 'Dismiss',
      'saved.dismiss_confirm': 'Dismiss?',
      'saved.dismiss_confirm_title': 'Click again to confirm dismiss',
      'saved.delete_confirm': 'Delete?',
      'saved.delete_confirm_title': 'Click again to confirm permanent delete',
      'saved.reopen_closed': 'Reopen closed tab',
      'saved.restore_tooltip': 'Restore to Saved for later',
      'saved.delete_tooltip': 'Delete permanently',
      'archive.toggle_label': 'Archive',
      'archive.search_placeholder': 'Search archived tabs...',
      'archive.restore': 'Restore',
      'archive.delete': 'Delete',
      'archive.no_results': 'No results',
      'recently_closed.title': 'Recently closed',

      // Quick Return & Recent Bar
      'quick_return.label': 'Recent',
      'quick_return.back_to': 'Back to: {title} (Press Esc)',
      'quick_return.close': 'Dismiss quick return bar',
      'quick_return.card_tooltip': '{title} (Press Esc or 1 to return)',

      // Modals
      'modal.perspective.title_new': 'New Perspective',
      'modal.perspective.title_edit': 'Edit Perspective: {name}',
      'modal.perspective.name_label': 'Perspective Name',
      'modal.perspective.name_placeholder': 'e.g. Projects, Priority, Reading',
      'modal.perspective.tags_label': 'Tags & AI Classification Rules',
      'modal.perspective.tags_hint': 'Each tag has a name and instruct description for OpenRouter Jev classification',
      'modal.perspective.add_tag': 'Add tag',
      'modal.perspective.tag_name_placeholder': 'Tag name (e.g. Work, Research)',
      'modal.perspective.tag_instruct_placeholder': 'Description / AI prompt instructions (optional)',
      'modal.perspective.drag_tag': 'Drag or use arrow keys to reorder tags',
      'modal.perspective.tag_color': 'Select tag color',
      'modal.perspective.delete_tag': 'Delete tag',
      'modal.perspective.swatch_none': 'Default (no color)',
      'modal.perspective.fallback_hint': 'Tag "Other" is the default for uncategorized tabs (managed by system, cannot be deleted).',
      'modal.perspective.delete': 'Delete',
      'modal.perspective.delete_title': 'Delete perspective "{name}"?',
      'modal.perspective.delete_desc': 'All custom tags and AI classification data for this perspective will be permanently removed from your browser.',
      'modal.perspective.delete_confirm': 'Delete permanently',
      'modal.perspective.delete_keep': 'Keep',
      'modal.perspective.reset_default': 'Reset to default',
      'modal.perspective.cancel': 'Cancel',
      'modal.perspective.save': 'Save & Apply',

      // Settings Modal
      'modal.settings.title': 'Settings',
      'modal.settings.language_label': 'Language',
      'modal.settings.language_en': 'English',
      'modal.settings.language_vi': 'Tiếng Việt',
      'modal.settings.api_key_label': 'OpenRouter API Key (Optional)',
      'modal.settings.api_key_placeholder': 'sk-or-v1-... (leave blank to use smart local rules)',
      'modal.settings.api_key_help': 'Uses ~typesafe/jev-latest via OpenRouter Decisions API. If empty or offline, local rules are used instantly.',
      'modal.settings.cancel': 'Cancel',
      'modal.settings.save': 'Save Settings',

      // Confirm Dialog
      'modal.confirm.title': 'Confirmation',
      'modal.confirm.cancel': 'Cancel',
      'modal.confirm.ok': 'Confirm',
      'dialog.close_all_title': 'Close all {count} tabs?',
      'dialog.close_all_desc': 'You are about to close all {count} open tabs {scope}. Unsaved forms and page states will be closed.',
      'dialog.close_all_confirm': 'Close all {count} tabs',
      'dialog.scope_across_windows': 'across all {count} windows',
      'dialog.scope_this_window': 'in this window',

      // Toast Notifications
      'toast.undo': 'Undo',
      'toast.tabs_closed': 'Closed {count} tabs',
      'toast.tab_closed': 'Tab closed',
      'toast.tab_restored': 'Restored tab',
      'toast.tab_restored_named': 'Restored "{title}"',
      'toast.tab_save_failed': 'Failed to save tab',
      'toast.tabs_restored_domain': 'Restored {count} tabs from {domain}',
      'toast.tabs_closed_domain': 'Closed {count} tabs from {domain}',
      'toast.tab_reopened': 'Tab reopened',
      'toast.restored_to_archive': 'Restored to archive',
      'toast.deleted_from_archive': 'Deleted from archive',
      'toast.settings_saved': 'Settings saved',
      'toast.perspective_saved': 'Perspective saved',
      'toast.perspective_created': 'Perspective created & applied',
      'toast.perspective_updated': 'Perspective updated',
      'toast.perspective_deleted': 'Perspective deleted',
      'toast.tags_reset': 'Reset to default tag list',
      'toast.enter_perspective_name': 'Please enter a perspective name',
      'toast.add_at_least_one_tag': 'Please add at least 1 tag',
      'toast.saved_for_later': 'Saved for later',
      'toast.all_tabs_closed': 'All tabs closed. Fresh start.',
      'toast.closed_extras': 'Closed extra Tab Out tabs',
      'toast.closed_dupes': 'Closed duplicates, kept one copy each',

      // Undo Descriptions
      'undo.closed_tabs_from': 'Closed {count} tabs from {domain}',
      'undo.closed_all_tabs': 'Closed all tabs',
      'undo.saved_dismissed': 'Saved tab dismissed',
      'undo.deleted_from_archive': 'Deleted from archive',

      // Telemetry
      'telemetry.status_active': 'Local classification active',
      'telemetry.status_offline': 'Classification offline',
      'telemetry.status_openrouter': 'OpenRouter Jev AI active',
      'telemetry.loading': 'AI is classifying open tabs with OpenRouter (~typesafe/jev-latest)...',

      // Relative Time
      'relative_time.just_now': 'just now',
      'relative_time.yesterday': 'yesterday',

      // Common Words
      'common.tab_single': 'tab',
      'common.tab_plural': 'tabs',
      'common.window_single': 'window',
      'common.window_plural': 'windows',
      'common.item_single': 'item',
      'common.item_plural': 'items',
      'common.loading': 'Loading...',
      'common.error': 'An error occurred'
    },
    vi: {
      // Header
      'header.skip_link': 'Chuyển đến nội dung chính',
      'header.active_tabs': 'Thẻ đang hoạt động',
      'header.subtitle': 'Tổng quan không gian làm việc trên tất cả các cửa sổ đang mở.',
      'header.open_tabs_count': '{count} thẻ đang mở',
      'header.open_tabs_count_suffix': 'thẻ đang mở',
      'header.tabs_across_windows': '{tabs} thẻ trên {windows} {windowWord}',

      // Dupe Banner
      'banner.dupe_count': 'Bạn đang mở {count} thẻ Tab Out',
      'banner.close_extras': 'Đóng các tab thừa',
      'banner.dismiss': 'Bỏ qua thông báo',

      // Perspectives Rail (Left column)
      'rail.perspectives': 'Góc nhìn',
      'rail.add_perspective': 'Thêm góc nhìn mới',
      'rail.new_perspective': 'Tạo góc nhìn mới',
      'rail.recent_tabs': 'Gần đây',
      'rail.rules_local': 'Quy tắc cục bộ',
      'rail.open_source': 'Mã nguồn mở',
      'rail.domain_default': 'Tên miền',
      'rail.topic_default': 'Chủ đề',
      'rail.purpose_default': 'Mục đích',
      'rail.settings': 'Cài đặt',
      'rail.openrouter_config': 'Cài đặt khóa API OpenRouter',
      'rail.edit_perspective': 'Chỉnh sửa góc nhìn',
      'rail.domain_tooltip': 'Domain: Gom nhóm theo tên miền URL — 100% nội bộ, không dùng AI',

      // Open Tabs Section (Middle column)
      'tabs.section_title': 'Thẻ đang mở',
      'tabs.domains_count': '{count} tên miền',
      'tabs.domains_local_single': 'tên miền · Cục bộ',
      'tabs.domains_local_plural': 'tên miền · Cục bộ',
      'tabs.categories_of': '{visible} trên {total} danh mục',
      'tabs.categories_single': 'danh mục',
      'tabs.categories_plural': 'danh mục',
      'tabs.all_closed_title': 'Đã đóng hết các thẻ',
      'tabs.all_closed_desc': 'Không gian làm việc gọn gàng',
      'tabs.quick_return': 'Quay lại thẻ trước',
      'tabs.close_all': 'Đóng tất cả',
      'tabs.close_all_count': 'Đóng tất cả {count} thẻ',
      'tabs.close_group': 'Đóng {count} thẻ',
      'tabs.close_group_confirm': 'Đóng {count} thẻ?',
      'tabs.close_dupes': 'Đóng {count} thẻ trùng',
      'tabs.edit_tags': 'Chỉnh sửa tags',
      'tabs.defer_group': 'Lưu lại sau',
      'tabs.landing_pages': 'Trang chủ',
      'tabs.filter_all': 'Tất cả',
      'tabs.filter_duplicates': 'Trùng lặp',
      'tabs.filter_audible': 'Âm thanh',
      'tabs.search_placeholder': 'Tìm kiếm thẻ...',
      'tabs.uncategorized': 'Khác',
      'chip.recent': 'Vừa xem',
      'chip.recent_title': 'Tab vừa xem gần nhất',
      'chip.save_for_later': 'Lưu lại sau',
      'chip.close_tab': 'Đóng thẻ này',
      'chip.show_more': '+{count} thẻ khác',
      'chip.show_more_aria': 'Xem thêm {count} thẻ khác',

      // Saved for Later / Archive (Right column)
      'saved.title': 'Đã lưu lại sau',
      'saved.empty': 'Chưa có thẻ nào được lưu.',
      'saved.clear_all': 'Xóa tất cả',
      'saved.restore_all': 'Khôi phục tất cả',
      'saved.items_count': '{count} {word}',
      'saved.item_dismiss': 'Bỏ qua',
      'saved.dismiss_confirm': 'Bỏ qua?',
      'saved.dismiss_confirm_title': 'Bấm lần nữa để xác nhận bỏ qua',
      'saved.delete_confirm': 'Xóa?',
      'saved.delete_confirm_title': 'Bấm lần nữa để xác nhận xóa vĩnh viễn',
      'saved.reopen_closed': 'Mở lại thẻ đã đóng',
      'saved.restore_tooltip': 'Khôi phục vào Đã lưu',
      'saved.delete_tooltip': 'Xóa vĩnh viễn',
      'archive.toggle_label': 'Lưu trữ',
      'archive.search_placeholder': 'Tìm thẻ đã lưu trữ...',
      'archive.restore': 'Khôi phục',
      'archive.delete': 'Xóa',
      'archive.no_results': 'Không có kết quả',
      'recently_closed.title': 'Đã đóng gần đây',

      // Quick Return & Recent Bar
      'quick_return.label': 'Vừa xem',
      'quick_return.back_to': 'Quay lại: {title} (Nhấn Esc)',
      'quick_return.close': 'Đóng thanh gợi ý quay lại',
      'quick_return.card_tooltip': '{title} (Nhấn Esc hoặc 1 để quay lại)',

      // Modals
      'modal.perspective.title_new': 'Thêm Perspective Mới',
      'modal.perspective.title_edit': 'Chỉnh sửa Perspective: {name}',
      'modal.perspective.name_label': 'Tên Góc nhìn',
      'modal.perspective.name_placeholder': 'ví dụ: Dự án, Ưu tiên, Đọc dở',
      'modal.perspective.tags_label': 'Danh sách Tags & Hướng dẫn phân loại cho AI',
      'modal.perspective.tags_hint': 'Mỗi tag có tên và mô tả/instruct riêng để OpenRouter Jev phân loại chuẩn xác',
      'modal.perspective.add_tag': 'Thêm tag',
      'modal.perspective.tag_name_placeholder': 'Tên tag (vd: Công việc, Nghiên cứu)',
      'modal.perspective.tag_instruct_placeholder': 'Mô tả / Hướng dẫn AI (để trống AI tự hiểu theo tên tag)',
      'modal.perspective.drag_tag': 'Kéo hoặc dùng phím mũi tên để sắp xếp tag',
      'modal.perspective.tag_color': 'Chọn màu tag',
      'modal.perspective.delete_tag': 'Xóa tag',
      'modal.perspective.swatch_none': 'Mặc định (không màu)',
      'modal.perspective.fallback_hint': 'Tag "Khác" là mặc định cho mọi tab chưa phân loại (hệ thống tự quản lý, không thể xóa).',
      'modal.perspective.delete': 'Xóa',
      'modal.perspective.delete_title': 'Xóa perspective "{name}"?',
      'modal.perspective.delete_desc': 'Toàn bộ tags tùy chỉnh và dữ liệu phân loại AI của perspective này sẽ bị xóa vĩnh viễn khỏi trình duyệt.',
      'modal.perspective.delete_confirm': 'Xóa vĩnh viễn',
      'modal.perspective.delete_keep': 'Giữ lại',
      'modal.perspective.reset_default': 'Khôi phục mặc định',
      'modal.perspective.cancel': 'Hủy',
      'modal.perspective.save': 'Lưu & Áp dụng',

      // Settings Modal
      'modal.settings.title': 'Cài đặt',
      'modal.settings.language_label': 'Ngôn ngữ',
      'modal.settings.language_en': 'English',
      'modal.settings.language_vi': 'Tiếng Việt',
      'modal.settings.api_key_label': 'Khóa API OpenRouter (Tùy chọn)',
      'modal.settings.api_key_placeholder': 'sk-or-v1-... (để trống để dùng quy tắc cục bộ thông minh)',
      'modal.settings.api_key_help': 'Sử dụng ~typesafe/jev-latest qua OpenRouter Decisions API. Nếu để trống hoặc offline, quy tắc cục bộ sẽ được sử dụng ngay lập tức.',
      'modal.settings.cancel': 'Hủy',
      'modal.settings.save': 'Lưu Cài đặt',

      // Confirm Dialog
      'modal.confirm.title': 'Xác nhận',
      'modal.confirm.cancel': 'Hủy',
      'modal.confirm.ok': 'Xác nhận',
      'dialog.close_all_title': 'Đóng tất cả {count} thẻ?',
      'dialog.close_all_desc': 'Bạn sắp đóng tất cả {count} thẻ đang mở {scope}. Biểu mẫu chưa lưu và trạng thái trang sẽ bị mất.',
      'dialog.close_all_confirm': 'Đóng tất cả {count} thẻ',
      'dialog.scope_across_windows': 'trên tất cả {count} cửa sổ',
      'dialog.scope_this_window': 'trong cửa sổ này',

      // Toast Notifications
      'toast.undo': 'Hoàn tác',
      'toast.tabs_closed': 'Đã đóng {count} thẻ',
      'toast.tab_closed': 'Đã đóng thẻ',
      'toast.tab_restored': 'Đã khôi phục thẻ',
      'toast.tab_restored_named': 'Đã khôi phục "{title}"',
      'toast.tab_save_failed': 'Không thể lưu thẻ',
      'toast.tabs_restored_domain': 'Đã khôi phục {count} thẻ từ {domain}',
      'toast.tabs_closed_domain': 'Đã đóng {count} thẻ từ {domain}',
      'toast.tab_reopened': 'Đã mở lại thẻ',
      'toast.restored_to_archive': 'Đã khôi phục vào lưu trữ',
      'toast.deleted_from_archive': 'Đã xóa khỏi lưu trữ',
      'toast.settings_saved': 'Đã lưu cài đặt',
      'toast.perspective_saved': 'Đã lưu góc nhìn',
      'toast.perspective_created': 'Perspective đã được tạo & áp dụng',
      'toast.perspective_updated': 'Perspective đã được cập nhật',
      'toast.perspective_deleted': 'Đã xóa góc nhìn',
      'toast.tags_reset': 'Đã khôi phục danh sách tag mặc định',
      'toast.enter_perspective_name': 'Vui lòng nhập tên Perspective',
      'toast.add_at_least_one_tag': 'Vui lòng thêm ít nhất 1 tag',
      'toast.saved_for_later': 'Đã lưu lại sau',
      'toast.all_tabs_closed': 'Đã đóng tất cả thẻ. Bắt đầu mới.',
      'toast.closed_extras': 'Đã đóng các tab Tab Out thừa',
      'toast.closed_dupes': 'Đã đóng các thẻ trùng, giữ lại 1 bản sao',

      // Undo Descriptions
      'undo.closed_tabs_from': 'Đã đóng {count} thẻ từ {domain}',
      'undo.closed_all_tabs': 'Đã đóng tất cả thẻ',
      'undo.saved_dismissed': 'Đã bỏ qua thẻ đã lưu',
      'undo.deleted_from_archive': 'Đã xóa khỏi lưu trữ',

      // Telemetry
      'telemetry.status_active': 'Phân loại cục bộ đang hoạt động',
      'telemetry.status_offline': 'Phân loại ngoại tuyến',
      'telemetry.status_openrouter': 'OpenRouter Jev AI đang hoạt động',
      'telemetry.loading': 'AI đang phân loại các thẻ đang mở bằng OpenRouter (~typesafe/jev-latest)...',

      // Relative Time
      'relative_time.just_now': 'vừa xong',
      'relative_time.yesterday': 'hôm qua',

      // Common Words
      'common.tab_single': 'thẻ',
      'common.tab_plural': 'thẻ',
      'common.window_single': 'cửa sổ',
      'common.window_plural': 'cửa sổ',
      'common.item_single': 'mục',
      'common.item_plural': 'mục',
      'common.loading': 'Đang tải...',
      'common.error': 'Đã có lỗi xảy ra'
    }
  };

  // Determine initial language: storage -> navigator.language -> fallback 'en'
  function detectDefaultLanguage() {
    try {
      const browserLang = (typeof navigator !== 'undefined' && navigator.language) ? navigator.language.toLowerCase() : 'en';
      if (browserLang.startsWith('vi')) return 'vi';
    } catch (_) {}
    return 'en';
  }

  let currentLang = detectDefaultLanguage();
  let isInitialized = false;

  /**
   * Asynchronously initialize language from storage.
   * Returns a promise that resolves with the active language code.
   * @returns {Promise<'en' | 'vi'>}
   */
  async function init() {
    if (isInitialized) return currentLang;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const result = await new Promise((resolve) => {
          chrome.storage.local.get([STORAGE_KEY], (res) => resolve(res || {}));
        });
        if (result && result[STORAGE_KEY] && (result[STORAGE_KEY] === 'en' || result[STORAGE_KEY] === 'vi')) {
          setLanguage(result[STORAGE_KEY], false);
        } else {
          setLanguage(detectDefaultLanguage(), false);
        }
      }
    } catch (_) {}
    isInitialized = true;
    return currentLang;
  }

  // Synchronously initialize language from cached storage if available in Chrome MV3
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get([STORAGE_KEY], function (result) {
        if (!isInitialized && result && result[STORAGE_KEY] && (result[STORAGE_KEY] === 'en' || result[STORAGE_KEY] === 'vi')) {
          setLanguage(result[STORAGE_KEY], false);
        }
      });
    }
  } catch (_) {}

  /**
   * Get active language code
   * @returns {'en' | 'vi'}
   */
  function getLanguage() {
    return currentLang;
  }

  /**
   * Switch language and optionally persist to storage and dispatch event
   * @param {'en' | 'vi'} lang 
   * @param {boolean} [persist=true] 
   */
  function setLanguage(lang, persist) {
    if (lang !== 'en' && lang !== 'vi') return;
    const changed = currentLang !== lang;
    currentLang = lang;

    if (persist !== false) {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ [STORAGE_KEY]: lang });
        }
      } catch (_) {}
    }

    // Always apply translations to the DOM and update root lang attribute
    if (typeof document !== 'undefined') {
      if (document.documentElement) {
        document.documentElement.lang = currentLang;
      }
      applyI18n(document);
    }

    // Notify application components if language changed or explicitly dispatched
    if (changed || persist !== false) {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        try {
          window.dispatchEvent(new CustomEvent('tabout:language-changed', {
            detail: { language: currentLang }
          }));
        } catch (_) {}
      }
    }
  }

  /**
   * Translate key with optional parameter substitution
   * @param {string} key 
   * @param {Record<string, any>} [params] 
   * @returns {string}
   */
  function t(key, params) {
    const dict = TRANSLATIONS[currentLang] || TRANSLATIONS.en;
    let template = dict[key];

    // Fallback to English if translation is missing in Vietnamese
    if (template === undefined) {
      template = TRANSLATIONS.en[key];
    }

    // Final fallback: return key itself
    if (template === undefined) {
      return key;
    }

    if (!params) return template;

    return template.replace(/\{(\w+)\}/g, function (match, paramKey) {
      return (params && typeof params === 'object' && Object.prototype.hasOwnProperty.call(params, paramKey) && params[paramKey] !== undefined)
        ? String(params[paramKey])
        : match;
    });
  }

  /**
   * Scan DOM tree for elements with data-i18n attributes and apply translations
   * @param {Document | HTMLElement} [root] 
   */
  function applyI18n(root) {
    const target = root || (typeof document !== 'undefined' ? document : null);
    if (!target || typeof target.querySelectorAll !== 'function') return;

    // Translate text content
    const elements = target.querySelectorAll('[data-i18n]');
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const key = el.getAttribute('data-i18n');
      if (key) {
        el.textContent = t(key);
      }
    }

    // Translate placeholder attributes
    const placeholderEls = target.querySelectorAll('[data-i18n-placeholder]');
    for (let i = 0; i < placeholderEls.length; i++) {
      const el = placeholderEls[i];
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) {
        el.setAttribute('placeholder', t(key));
      }
    }

    // Translate title attributes
    const titleEls = target.querySelectorAll('[data-i18n-title]');
    for (let i = 0; i < titleEls.length; i++) {
      const el = titleEls[i];
      const key = el.getAttribute('data-i18n-title');
      if (key) {
        el.setAttribute('title', t(key));
      }
    }

    // Translate aria-label attributes
    const ariaEls = target.querySelectorAll('[data-i18n-aria-label]');
    for (let i = 0; i < ariaEls.length; i++) {
      const el = ariaEls[i];
      const key = el.getAttribute('data-i18n-aria-label');
      if (key) {
        el.setAttribute('aria-label', t(key));
      }
    }
  }

  /**
   * Format date according to current locale
   * @param {Date | number} date
   * @param {Intl.DateTimeFormatOptions} [options]
   * @returns {string}
   */
  function formatDate(date, options) {
    const targetDate = typeof date === 'number' ? new Date(date) : date;
    const locale = currentLang === 'vi' ? 'vi-VN' : 'en-US';
    const opts = options || { weekday: 'short', month: 'short', day: 'numeric' };
    try {
      return new Intl.DateTimeFormat(locale, opts).format(targetDate);
    } catch (_) {
      return targetDate.toDateString();
    }
  }

  /**
   * Format number according to current locale
   * @param {number} num
   * @returns {string}
   */
  function formatNumber(num) {
    const locale = currentLang === 'vi' ? 'vi-VN' : 'en-US';
    try {
      return new Intl.NumberFormat(locale).format(num);
    } catch (_) {
      return String(num);
    }
  }

  /**
   * Format relative time according to current locale
   * @param {Date | number | string} date
   * @returns {string}
   */
  function formatRelativeTime(date) {
    if (!date) return '';
    const ts = typeof date === 'string' ? new Date(date).getTime() : (typeof date === 'number' ? date : date.getTime());
    if (isNaN(ts)) return '';
    const now = Date.now();
    const diffSec = Math.round((now - ts) / 1000);
    const diffMin = Math.round(diffSec / 60);
    const diffHour = Math.round(diffMin / 60);
    const diffDay = Math.round(diffHour / 24);
    const diffMonth = Math.round(diffDay / 30);
    const diffYear = Math.round(diffDay / 365);

    const locale = currentLang === 'vi' ? 'vi' : 'en';

    if (Math.abs(diffSec) < 45) {
      return t('relative_time.just_now');
    }

    try {
      if (typeof Intl !== 'undefined' && Intl.RelativeTimeFormat) {
        const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
        if (Math.abs(diffMin) < 60) {
          return rtf.format(-diffMin, 'minute');
        }
        if (Math.abs(diffHour) < 24) {
          return rtf.format(-diffHour, 'hour');
        }
        if (Math.abs(diffDay) < 30) {
          return rtf.format(-diffDay, 'day');
        }
        if (Math.abs(diffMonth) < 12) {
          return rtf.format(-diffMonth, 'month');
        }
        return rtf.format(-diffYear, 'year');
      }
    } catch (_) {}

    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay < 30) return `${diffDay}d ago`;
    if (diffMonth < 12) return `${diffMonth}mo ago`;
    return `${diffYear}y ago`;
  }

  const TabOutI18n = {
    init: init,
    t: t,
    getLanguage: getLanguage,
    setLanguage: setLanguage,
    applyI18n: applyI18n,
    formatDate: formatDate,
    formatNumber: formatNumber,
    formatRelativeTime: formatRelativeTime,
    TRANSLATIONS: TRANSLATIONS
  };

  // Expose to window and module systems
  global.TabOutI18n = TabOutI18n;
  global.t = t;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TabOutI18n;
  }
})(typeof window !== 'undefined' ? window : globalThis);
