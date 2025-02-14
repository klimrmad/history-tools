// copyright defined in LICENSE.txt

#pragma once

#include "lmdb_plugin.hpp"
#include "wasm_ql_plugin.hpp"

class wasm_ql_lmdb_plugin : public appbase::plugin<wasm_ql_lmdb_plugin> {
  public:
    APPBASE_PLUGIN_REQUIRES((lmdb_plugin)(wasm_ql_plugin))

    wasm_ql_lmdb_plugin();
    virtual ~wasm_ql_lmdb_plugin();

    virtual void set_program_options(appbase::options_description& cli, appbase::options_description& cfg) override;
    void         plugin_initialize(const appbase::variables_map& options);
    void         plugin_startup();
    void         plugin_shutdown();

  private:
    std::shared_ptr<struct wasm_ql_lmdb_plugin_impl> my;
};
